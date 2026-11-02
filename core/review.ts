/**
 * The review's events and the one function that applies them. Every change to a review goes through `reduce`, which is
 * pure: a host can replay, test and persist reviews without running anything.
 */
import { agentLabel } from "./agents.ts";
import { MAX_ACTIVITY, REVIEW_FORMAT, isRunning, seatedReviewers, type Activity, type ActivityKind, type Finding, type Review, type Reviewer, type RunnerKind } from "./model.ts";
import type { FindingInput, Seat, Setup, SetupPatch } from "./schemas.ts";

export type ReviewerOutcome = "completed" | "failed" | "stopped";

/** What a reviewer's runner reports. */
export type ReviewerEvent =
  | { type: "reviewer-started"; reviewerId: string; at: number }
  | { type: "activity"; reviewerId: string; at: number; kind: ActivityKind; text: string; path?: string }
  | { type: "finding-reported"; reviewerId: string; at: number; finding: FindingInput }
  | { type: "reviewer-finished"; reviewerId: string; at: number; outcome: ReviewerOutcome; problem?: string };

export type ReviewEvent =
  | ReviewerEvent
  | { type: "configured"; patch: SetupPatch }
  | { type: "started"; at: number }
  | { type: "stopped"; at: number }
  /** The host lost the run, as when Mirador restarted while it went on. */
  | { type: "interrupted"; at: number }
  /** The host's agent was told how the review ended. */
  | { type: "agent-heard"; at: number };

/** Thrown for an event the review can't take now; its message says why, for whoever sent it. */
export class ReviewError extends Error {}

const reviewerOf = (seat: Seat, index: number): Reviewer => ({
  id: `r${index + 1}`,
  agent: seat.agent,
  label: agentLabel(seat.agent),
  enabled: seat.enabled,
  status: "idle",
  current: null,
  activity: [],
  activityCount: 0,
  startedAt: null,
  endedAt: null,
  problem: null,
});

export function newReview(id: string, setup: Setup, runner: RunnerKind, at: number): Review {
  return {
    format: REVIEW_FORMAT,
    id,
    target: setup.target,
    profile: setup.profile,
    depth: setup.depth,
    instructions: setup.instructions,
    runner,
    phase: "setup",
    reviewers: setup.seats.map(reviewerOf),
    findings: [],
    createdAt: at,
    startedAt: null,
    endedAt: null,
    seq: 0,
    agentHeardAt: null,
  };
}

/** The setup a review was made with, as the view edits it. */
export const setupOf = (review: Review): Setup => ({
  target: review.target,
  profile: review.profile,
  depth: review.depth,
  instructions: review.instructions,
  seats: review.reviewers.map(({ agent, enabled }) => ({ agent, enabled })),
});

const updateReviewer = (review: Review, reviewerId: string, update: (reviewer: Reviewer) => Reviewer): Review => ({
  ...review,
  reviewers: review.reviewers.map((reviewer) => (reviewer.id === reviewerId ? update(reviewer) : reviewer)),
});

function withActivity(reviewer: Reviewer, activity: Omit<Activity, "seq">): Reviewer {
  const seq = reviewer.activityCount + 1;
  const kept = [...reviewer.activity, { ...activity, seq }];
  return { ...reviewer, activity: kept.length > MAX_ACTIVITY ? kept.slice(kept.length - MAX_ACTIVITY) : kept, activityCount: seq };
}

/** What a reviewer is doing, as its newest activity says; a note or a finding doesn't change it. */
const currentAfter = (reviewer: Reviewer, kind: ActivityKind, text: string) => (kind === "note" || kind === "finding" ? reviewer.current : text);

const isActive = (reviewer: Reviewer) => reviewer.enabled && (reviewer.status === "waiting" || reviewer.status === "reviewing");

/** Ends every reviewer still at work, as a stop or an interruption does. */
const endActive = (review: Review, at: number): Reviewer[] =>
  review.reviewers.map((reviewer) => (isActive(reviewer) ? { ...reviewer, status: "stopped", current: "Stopped", endedAt: at } : reviewer));

function applyEvent(review: Review, event: ReviewEvent): Review {
  switch (event.type) {
    case "configured": {
      if (review.phase !== "setup") throw new ReviewError("The review has started; its setup can't change any more.");
      const { seats, ...rest } = event.patch;
      const reviewers = seats ? seats.map((seat, index) => ({ ...reviewerOf(seat, index), id: review.reviewers[index]?.id ?? `r${index + 1}` })) : review.reviewers;
      return { ...review, ...rest, reviewers };
    }
    case "started": {
      if (review.phase !== "setup") throw new ReviewError(`The review can't start: it is ${review.phase}.`);
      if (seatedReviewers(review).length === 0) throw new ReviewError("Seat at least one reviewer before starting the review.");
      return {
        ...review,
        phase: "independent-review",
        startedAt: event.at,
        reviewers: review.reviewers.map((reviewer) => (reviewer.enabled ? { ...reviewer, status: "waiting", current: "Waiting to start" } : reviewer)),
      };
    }
    case "stopped":
    case "interrupted": {
      if (!isRunning(review)) return review;
      return { ...review, phase: event.type, endedAt: event.at, reviewers: endActive(review, event.at) };
    }
    case "agent-heard":
      return { ...review, agentHeardAt: event.at };
    default:
      return applyReviewerEvent(review, event);
  }
}

/** A runner's event; one that comes after its reviewer or the review ended (a stop races the runner) changes nothing. */
function applyReviewerEvent(review: Review, event: ReviewerEvent): Review {
  const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
  if (!reviewer || !reviewer.enabled) throw new ReviewError(`No reviewer ${event.reviewerId} takes part in the review.`);
  if (!isRunning(review) || !isActive(reviewer)) return review;
  switch (event.type) {
    case "reviewer-started":
      return updateReviewer(review, reviewer.id, (it) => ({ ...it, status: "reviewing", current: "Starting", startedAt: event.at }));
    case "activity":
      return updateReviewer(review, reviewer.id, (it) => ({
        ...withActivity(it, { at: event.at, kind: event.kind, text: event.text, ...(event.path === undefined ? {} : { path: event.path }) }),
        current: currentAfter(it, event.kind, event.text),
      }));
    case "finding-reported": {
      const finding: Finding = {
        ...event.finding,
        id: `F${review.findings.length + 1}`,
        reviewerId: reviewer.id,
        status: "reported",
        reportedAt: event.at,
      };
      const reported = updateReviewer(review, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "finding", text: `Reported ${finding.id}: ${finding.title}`, ...(finding.evidence[0] ? { path: finding.evidence[0].path } : {}) }),
      );
      return { ...reported, findings: [...review.findings, finding] };
    }
    case "reviewer-finished": {
      const current = event.outcome === "completed" ? "Review complete" : event.outcome === "failed" ? "Failed" : "Stopped";
      const finished = updateReviewer(review, reviewer.id, (it) => ({ ...it, status: event.outcome, current, endedAt: event.at, problem: event.problem ?? null }));
      const allDone = seatedReviewers(finished).every((it) => !isActive(it));
      return allDone ? { ...finished, phase: "complete", endedAt: event.at } : finished;
    }
  }
}

/** Applies one event; the review it gives back has the next sequence number unless the event changed nothing. */
export function reduce(review: Review, event: ReviewEvent): Review {
  const next = applyEvent(review, event);
  return next === review ? review : { ...next, seq: review.seq + 1 };
}
