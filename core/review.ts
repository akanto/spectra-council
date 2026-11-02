/**
 * The review's events and the one function that applies them. Every change to a review goes through `reduce`, which is
 * pure: a host can replay, test and persist reviews without running anything.
 *
 * A review runs: started → each reviewer reviews on its own → (deliberation-started → round-started × rounds, in which
 * reviewers argue about the findings → synthesis-started → finding-resolved for each finding) → concluded. A review
 * with nothing to deliberate goes straight from the independent review to concluded.
 */
import { agentLabel } from "./agents.ts";
import {
  MAX_ACTIVITY,
  REVIEW_FORMAT,
  isActive,
  isRunning,
  seatedReviewers,
  type Activity,
  type ActivityKind,
  type Argument,
  type Finding,
  type FindingStatus,
  type Position,
  type Review,
  type Reviewer,
  type RunnerKind,
  type Stance,
} from "./model.ts";
import type { ArgumentInput, FindingInput, Seat, Setup, SetupPatch } from "./schemas.ts";

export type ReviewerOutcome = "completed" | "failed" | "stopped";

/** What a reviewer's runner reports. */
export type ReviewerEvent =
  | { type: "reviewer-started"; reviewerId: string; at: number }
  | { type: "activity"; reviewerId: string; at: number; kind: ActivityKind; text: string; path?: string }
  | { type: "finding-reported"; reviewerId: string; at: number; finding: FindingInput }
  /** A stance on a finding, in the deliberation's current round. */
  | { type: "argued"; reviewerId: string; at: number; argument: ArgumentInput }
  | { type: "reviewer-finished"; reviewerId: string; at: number; outcome: ReviewerOutcome; problem?: string };

export type ReviewEvent =
  | ReviewerEvent
  | { type: "configured"; patch: SetupPatch }
  | { type: "started"; at: number }
  /** The independent review is over and the findings go on the table: the reviewers who finished it take part. */
  | { type: "deliberation-started"; at: number; rounds: number }
  | { type: "round-started"; at: number; round: number }
  | { type: "synthesis-started"; at: number }
  | { type: "finding-resolved"; at: number; findingId: string; status: Exclude<FindingStatus, "reported">; rationale: string; dissenters: string[] }
  /** The review ends with the council's verdict. */
  | { type: "concluded"; at: number; summary: string }
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
    arguments: [],
    round: 0,
    rounds: 0,
    verdict: null,
    createdAt: at,
    startedAt: null,
    endedAt: null,
    seq: 0,
    agentHeardAt: null,
  };
}

/**
 * A review as stored by an earlier version, brought up to this one: format 1 had no deliberation. Hosts read stored
 * reviews through this before anything else touches them.
 */
export function upgradeReview(stored: Review): Review {
  if (stored.format === REVIEW_FORMAT) return stored;
  const old = stored as Partial<Review> & Omit<Review, "arguments" | "round" | "rounds" | "verdict">;
  return {
    ...old,
    format: REVIEW_FORMAT,
    findings: old.findings.map((finding) => ({ ...finding, positions: finding.positions ?? [], resolution: finding.resolution ?? null })),
    arguments: old.arguments ?? [],
    round: old.round ?? 0,
    rounds: old.rounds ?? 0,
    verdict: old.verdict ?? null,
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

const updateFinding = (review: Review, findingId: string, update: (finding: Finding) => Finding): Review => ({
  ...review,
  findings: review.findings.map((finding) => (finding.id === findingId ? update(finding) : finding)),
});

function withActivity(reviewer: Reviewer, activity: Omit<Activity, "seq">): Reviewer {
  const seq = reviewer.activityCount + 1;
  const kept = [...reviewer.activity, { ...activity, seq }];
  return { ...reviewer, activity: kept.length > MAX_ACTIVITY ? kept.slice(kept.length - MAX_ACTIVITY) : kept, activityCount: seq };
}

/** What a reviewer is doing, as its newest activity says; a note, a finding or an argument doesn't change it. */
const currentAfter = (reviewer: Reviewer, kind: ActivityKind, text: string) => (kind === "note" || kind === "finding" || kind === "argument" ? reviewer.current : text);

/** Ends every reviewer still at work, as a stop or an interruption does. */
const endActive = (review: Review, at: number): Reviewer[] =>
  review.reviewers.map((reviewer) => (isActive(reviewer) ? { ...reviewer, status: "stopped", current: "Stopped", endedAt: at } : reviewer));

/** Sets every reviewer in the deliberation to say what it does now. */
const deliberatingSay = (review: Review, current: string): Reviewer[] =>
  review.reviewers.map((reviewer) => (reviewer.enabled && reviewer.status === "deliberating" ? { ...reviewer, current } : reviewer));

export const STANCE_VERBS: Record<Stance, string> = { supports: "Backs", challenges: "Challenges", uncertain: "Unsure about" };

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
    case "deliberation-started": {
      if (review.phase !== "independent-review") throw new ReviewError(`The deliberation can't start: the review is ${review.phase}.`);
      if (seatedReviewers(review).some((reviewer) => reviewer.status === "waiting" || reviewer.status === "reviewing")) {
        throw new ReviewError("The deliberation can't start while reviewers are still reviewing.");
      }
      if (event.rounds < 1) throw new ReviewError("A deliberation has at least one round.");
      return {
        ...review,
        phase: "deliberation",
        round: 0,
        rounds: event.rounds,
        reviewers: review.reviewers.map((reviewer) => (reviewer.enabled && reviewer.status === "completed" ? { ...reviewer, status: "deliberating", current: "Reading the other findings" } : reviewer)),
        findings: review.findings.map((finding) => ({
          ...finding,
          positions: [{ reviewerId: finding.reviewerId, stance: "supports", confidence: finding.confidence, round: 0, at: event.at }],
        })),
      };
    }
    case "round-started": {
      if (review.phase !== "deliberation") throw new ReviewError(`No round can start: the review is ${review.phase}.`);
      if (event.round !== review.round + 1 || event.round > review.rounds) throw new ReviewError(`Round ${event.round} can't follow round ${review.round} of ${review.rounds}.`);
      return { ...review, round: event.round, reviewers: deliberatingSay(review, `Round ${event.round}: weighing the findings`) };
    }
    case "synthesis-started": {
      if (review.phase !== "deliberation") throw new ReviewError(`The synthesis can't start: the review is ${review.phase}.`);
      return { ...review, phase: "synthesis", reviewers: deliberatingSay(review, "Awaiting the verdict") };
    }
    case "finding-resolved": {
      if (review.phase !== "synthesis") throw new ReviewError(`A finding can't be resolved: the review is ${review.phase}.`);
      if (!review.findings.some((finding) => finding.id === event.findingId)) throw new ReviewError(`There is no finding ${event.findingId}.`);
      const { status, rationale, dissenters, at } = event;
      return updateFinding(review, event.findingId, (finding) => ({ ...finding, status, resolution: { status, rationale, dissenters, at } }));
    }
    case "concluded": {
      if (!isRunning(review)) throw new ReviewError(`The review can't conclude: it is ${review.phase}.`);
      if (seatedReviewers(review).some((reviewer) => reviewer.status === "waiting" || reviewer.status === "reviewing")) {
        throw new ReviewError("The review can't conclude while reviewers are still reviewing.");
      }
      return {
        ...review,
        phase: "complete",
        endedAt: event.at,
        verdict: { summary: event.summary, at: event.at },
        reviewers: review.reviewers.map((reviewer) =>
          reviewer.enabled && reviewer.status === "deliberating" ? { ...reviewer, status: "completed", current: "Verdict in", endedAt: event.at } : reviewer,
        ),
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
      if (review.phase !== "independent-review") throw new ReviewError(`Findings are reported in the independent review; the review is in ${review.phase}.`);
      const finding: Finding = {
        ...event.finding,
        id: `F${review.findings.length + 1}`,
        reviewerId: reviewer.id,
        status: "reported",
        reportedAt: event.at,
        positions: [],
        resolution: null,
      };
      const reported = updateReviewer(review, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "finding", text: `Reported ${finding.id}: ${finding.title}`, ...(finding.evidence[0] ? { path: finding.evidence[0].path } : {}) }),
      );
      return { ...reported, findings: [...review.findings, finding] };
    }
    case "argued": {
      if (review.phase !== "deliberation" || review.round < 1) throw new ReviewError(`Arguments are made in a deliberation round; the review is in ${review.phase}.`);
      const input = event.argument;
      const finding = review.findings.find(({ id }) => id === input.findingId);
      if (!finding) throw new ReviewError(`There is no finding ${input.findingId}.`);
      if (input.replyTo !== undefined && !review.arguments.some(({ id }) => id === input.replyTo)) throw new ReviewError(`There is no argument ${input.replyTo}.`);
      const argument: Argument = {
        id: `A${review.arguments.length + 1}`,
        findingId: finding.id,
        reviewerId: reviewer.id,
        round: review.round,
        stance: input.stance,
        confidence: input.confidence,
        text: input.text,
        evidence: input.evidence,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        at: event.at,
      };
      const position: Position = { reviewerId: reviewer.id, stance: input.stance, confidence: input.confidence, round: review.round, at: event.at };
      const argued = updateReviewer(
        updateFinding(review, finding.id, (it) => ({ ...it, positions: [...it.positions.filter(({ reviewerId }) => reviewerId !== reviewer.id), position] })),
        reviewer.id,
        (it) => withActivity(it, { at: event.at, kind: "argument", text: `${STANCE_VERBS[input.stance]} ${finding.id}: ${finding.title}`, ...(input.evidence[0] ? { path: input.evidence[0].path } : {}) }),
      );
      return { ...argued, arguments: [...review.arguments, argument] };
    }
    case "reviewer-finished": {
      const current = event.outcome === "completed" ? "Review complete" : event.outcome === "failed" ? "Failed" : "Stopped";
      return updateReviewer(review, reviewer.id, (it) => ({ ...it, status: event.outcome, current, endedAt: event.at, problem: event.problem ?? null }));
    }
  }
}

/** Applies one event; the review it gives back has the next sequence number unless the event changed nothing. */
export function reduce(review: Review, event: ReviewEvent): Review {
  const next = applyEvent(review, event);
  return next === review ? review : { ...next, seq: review.seq + 1 };
}
