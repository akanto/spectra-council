/**
 * The review's events and the one function that applies them. Every change to a review goes through `reduce`, which is
 * pure: a host can replay, test and persist reviews without running anything.
 *
 * A review runs: started → each reviewer reviews on its own → (deliberation-started → round-started × rounds, in which
 * reviewers argue about the findings → synthesis-started → finding-resolved for each finding → fix-proposed for those
 * that stand) → concluded. A review with nothing to deliberate goes straight from the independent review to concluded.
 *
 * After the verdict: the user rules on findings (ruled), the accepted ones go into a hand-off document
 * (handoff-written), the agent is asked to fix them (fix-requested) and reports each fix (fix-reported), and a
 * verification round has reviewers re-check the fixes (verification-started → fix-checked → verification-ended).
 */
import { agentLabel, isRunnableAgent, runnerKindOf, withLabels } from "./agents.ts";
import { DEPTH_PRESETS, depthOf, type DepthChoice, type Knobs } from "./depth.ts";
import {
  MAX_ACTIVITY,
  REVIEW_FORMAT,
  isActive,
  isRunning,
  seatedReviewers,
  type Activity,
  type ActivityKind,
  type Argument,
  type CoReport,
  type Decision,
  type Finding,
  type FindingStatus,
  type ModelInfo,
  type Position,
  type ResumablePhase,
  type Review,
  type Reviewer,
  type RunnerKind,
  type Stance,
} from "./model.ts";
import { SEVERITIES, type ArgumentInput, type Evidence, type FindingInput, type FixCheckInput, type ProposalInput, type Seat, type Setup, type SetupPatch } from "./schemas.ts";

export type ReviewerOutcome = "completed" | "failed" | "stopped";

/** What a reviewer's runner reports. */
export type ReviewerEvent =
  | { type: "reviewer-started"; reviewerId: string; at: number }
  | { type: "activity"; reviewerId: string; at: number; kind: ActivityKind; text: string; path?: string }
  | { type: "finding-reported"; reviewerId: string; at: number; finding: FindingInput }
  /** A stance on a finding, in the deliberation's current round. */
  | { type: "argued"; reviewerId: string; at: number; argument: ArgumentInput }
  /** A fix for a finding that stands, in the synthesis. */
  | { type: "fix-proposed"; reviewerId: string; at: number; proposal: ProposalInput }
  /** A re-check of a fixed finding, in a verification round. */
  | { type: "fix-checked"; reviewerId: string; at: number; check: FixCheckInput }
  | { type: "reviewer-finished"; reviewerId: string; at: number; outcome: ReviewerOutcome; problem?: string };

export type ReviewEvent =
  | ReviewerEvent
  /** The user retries a reviewer that failed in the independent review: its findings so far are dropped, and it waits to run again. */
  | { type: "reviewer-retried"; reviewerId: string; at: number }
  /**
   * After the independent review, findings that report the same problem merge: `merged` fold into `into`, which keeps
   * their reports (`alsoReported`), the highest severity and all the evidence. A rule's merge comes before the
   * deliberation; an agent's (`by`, the reviewer who grouped them, and its `reason`) in the grouping turn at its start,
   * before round 1.
   */
  | { type: "findings-merged"; at: number; into: string; merged: string[]; by?: string; reason?: string }
  /**
   * A reviewer's own review ended with more findings than the review allows (`maxFindings`): these, the least severe,
   * are dropped.
   */
  | { type: "findings-capped"; reviewerId: string; at: number; findingIds: string[] }
  /** The grouping turn at the start of the deliberation is over: an agent compared the findings by meaning. */
  | { type: "duplicates-checked"; at: number }
  /**
   * The user takes a failed reviewer off the council: it takes no part from now on, and its positions go. During the
   * independent review (or one a restart cut short) its findings go too, as nobody has weighed them yet; later they
   * stay on the record.
   */
  | { type: "reviewer-removed"; reviewerId: string; at: number }
  /**
   * A review a restart cut short goes on in the phase it was in: the work in flight then is dropped (the unfinished
   * reviewers' findings, the current round's arguments, the synthesis so far), to be done again.
   */
  | { type: "resumed"; at: number }
  | { type: "configured"; patch: SetupPatch }
  /**
   * The model a profile seat runs on, as the host learnt it: before the start, what the profile's latest conversation
   * ran on; once a turn started, what its conversation runs on. Relabels the seat by its model.
   */
  | { type: "model-seen"; reviewerId: string; model: ModelInfo }
  | { type: "started"; at: number }
  /** The independent review is over and the findings go on the table: the reviewers who finished it take part. */
  | { type: "deliberation-started"; at: number; rounds: number }
  | { type: "round-started"; at: number; round: number }
  | { type: "synthesis-started"; at: number }
  | { type: "finding-resolved"; at: number; findingId: string; status: Exclude<FindingStatus, "reported">; rationale: string; dissenters: string[] }
  /** The review ends with the council's verdict. */
  | { type: "concluded"; at: number; summary: string }
  /**
   * The user's decision on a finding after the verdict; null clears it. A finding handed off but not fixed yet can still
   * be dismissed or deferred, which takes it out of the fixes.
   */
  | { type: "ruled"; at: number; findingId: string; decision: Decision | null; note: string }
  /** The hand-off document of these (accepted) findings was written to `path`. */
  | { type: "handoff-written"; at: number; path: string; findingIds: string[] }
  /** The agent was asked to fix these accepted findings, by the hand-off. */
  /** The agent was asked to fix these accepted findings, by the hand-off: this conversation's, or another profile's. */
  | { type: "fix-requested"; at: number; findingIds: string[]; profile?: string }
  /** A conversation was started on the fixer's profile to fix these findings. */
  | { type: "fix-delegated"; at: number; findingIds: string[]; profile: string; conversationId: string }
  /** The fixer didn't fix these findings: what it said, or how its turn ended. */
  | { type: "fix-failed"; at: number; findingIds: string[]; reason: string }
  /** The agent says it fixed the finding: what it changed, and where. */
  | { type: "fix-reported"; at: number; findingId: string; summary: string; files: string[] }
  /** These reviewers re-check these fixed findings. */
  | { type: "verification-started"; at: number; findingIds: string[]; reviewerIds: string[] }
  /** Each finding checked in this round is verified, or reopened if any check reopened it. */
  | { type: "verification-ended"; at: number }
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
  model: null,
  enabled: seat.enabled,
  status: "idle",
  current: null,
  activity: [],
  activityCount: 0,
  startedAt: null,
  endedAt: null,
  problem: null,
});

/** The knobs a setup asks for: its depth preset's, with any knob it sets itself. */
const knobsOf = (setup: Pick<Setup, "depth" | "deliberationRounds" | "maxFindings">): Knobs => ({
  deliberationRounds: setup.deliberationRounds ?? DEPTH_PRESETS[setup.depth].deliberationRounds,
  maxFindings: setup.maxFindings ?? DEPTH_PRESETS[setup.depth].maxFindings,
});

export function newReview(id: string, setup: Setup, runner: RunnerKind, at: number): Review {
  const knobs = knobsOf(setup);
  return {
    format: REVIEW_FORMAT,
    id,
    target: setup.target,
    profile: setup.profile,
    depth: depthOf(knobs),
    ...knobs,
    instructions: setup.instructions,
    runner,
    phase: "setup",
    reviewers: withLabels(setup.seats.map(reviewerOf)),
    findings: [],
    arguments: [],
    round: 0,
    rounds: 0,
    verdict: null,
    handoff: null,
    verifications: 0,
    createdAt: at,
    startedAt: null,
    endedAt: null,
    seq: 0,
    agentHeardAt: null,
    findingsIssued: 0,
    interruptedPhase: null,
    duplicatesChecked: false,
  };
}

/**
 * A review as stored by an earlier version, brought up to this one: format 1 had no deliberation, format 2 no rulings,
 * fixes or verification, format 3 no fixer on a fix, format 4 no model on a reviewer, format 5 no merged reports and no
 * phase to resume in, format 6 no grouping turn (a review past the independent review counts as checked, so a resumed
 * one doesn't ask), format 7 no rounds or finding limit of its own (its depth preset's; a deliberation under way keeps
 * its rounds). Hosts read stored reviews through this before anything else touches them.
 */
export function upgradeReview(stored: Review): Review {
  if (stored.format === REVIEW_FORMAT) return stored;
  type Old = Omit<Review, "arguments" | "round" | "rounds" | "verdict" | "handoff" | "verifications" | "findings"> &
    Partial<Pick<Review, "arguments" | "round" | "rounds" | "verdict" | "handoff" | "verifications">> & { findings: Partial<Finding>[] };
  const old = stored as unknown as Old;
  return {
    ...old,
    format: REVIEW_FORMAT,
    reviewers: old.reviewers.map((reviewer) => ({ ...reviewer, model: (reviewer as Partial<Reviewer>).model ?? null })),
    findings: old.findings.map(
      (finding) =>
        ({
          ...finding,
          positions: finding.positions ?? [],
          resolution: finding.resolution ?? null,
          proposal: finding.proposal ?? null,
          ruling: finding.ruling ?? null,
          fix: finding.fix ? { ...finding.fix, fixer: finding.fix.fixer ?? null, problem: finding.fix.problem ?? null } : null,
          alsoReported: finding.alsoReported ?? [],
        }) as Finding,
    ),
    arguments: old.arguments ?? [],
    round: old.round ?? 0,
    rounds: old.rounds ?? 0,
    verdict: old.verdict ?? null,
    handoff: old.handoff ?? null,
    verifications: old.verifications ?? 0,
    findingsIssued: (old as Partial<Review>).findingsIssued ?? Math.max(0, ...old.findings.map((finding) => Number(finding.id?.slice(1)) || 0)),
    interruptedPhase: (old as Partial<Review>).interruptedPhase ?? null,
    ...upgradedKnobs(old as unknown as Review),
    depth: depthOf(upgradedKnobs(old as unknown as Review)),
    duplicatesChecked: (old as Partial<Review>).duplicatesChecked ?? !(old.phase === "setup" || old.phase === "independent-review" || (old as Partial<Review>).interruptedPhase === "independent-review"),
  };
}

/** A review stored before it had knobs gets its depth preset's; one that started deliberating keeps its rounds. */
function upgradedKnobs(old: Review): Knobs {
  if (typeof old.deliberationRounds === "number" && typeof old.maxFindings === "number") return { deliberationRounds: old.deliberationRounds, maxFindings: old.maxFindings };
  const preset = DEPTH_PRESETS[old.depth === "custom" ? "standard" : (old.depth ?? "standard")];
  return { deliberationRounds: old.rounds > 0 ? old.rounds : preset.deliberationRounds, maxFindings: preset.maxFindings };
}

/** The setup as the view edits it: a review's, with its depth (a preset or "custom") and both knobs. */
export type SetupState = Omit<Setup, "depth" | "deliberationRounds" | "maxFindings"> & Knobs & { depth: DepthChoice };

/** The setup a review was made with, as the view edits it. */
export const setupOf = (review: Review): SetupState => ({
  target: review.target,
  profile: review.profile,
  depth: review.depth,
  deliberationRounds: review.deliberationRounds,
  maxFindings: review.maxFindings,
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


/**
 * Each seated reviewer's position on a finding, from its latest argument; the reporter and co-reporters back it from
 * round 0. A reviewer the user removed has none.
 */
function positionsFrom(review: Review, finding: Finding, args: Argument[], at: number): Position[] {
  const positions = new Map<string, Position>();
  for (const reviewerId of [finding.reviewerId, ...finding.alsoReported.map((report) => report.reviewerId)]) {
    if (!positions.has(reviewerId)) positions.set(reviewerId, { reviewerId, stance: "supports", confidence: finding.confidence, round: 0, at });
  }
  for (const argument of args) {
    if (argument.findingId !== finding.id) continue;
    positions.delete(argument.reviewerId);
    positions.set(argument.reviewerId, { reviewerId: argument.reviewerId, stance: argument.stance, confidence: argument.confidence, round: argument.round, at: argument.at });
  }
  const seated = new Set(seatedReviewers(review).map(({ id }) => id));
  return [...positions.values()].filter((position) => seated.has(position.reviewerId));
}

const findingOf = (review: Review, findingId: string): Finding => {
  const finding = review.findings.find(({ id }) => id === findingId);
  if (!finding) throw new ReviewError(`There is no finding ${findingId}.`);
  return finding;
};

/**
 * Back to complete after a verification round: each fixed finding checked in it is verified, or reopened if any check
 * reopened it; one with no check stays fixed. A cut-short round settles nothing. The agent hears of the outcome anew.
 */
function endVerification(review: Review, at: number, current: string, settles = true): Review {
  const pass = review.verifications;
  return {
    ...review,
    phase: "complete",
    agentHeardAt: settles ? null : review.agentHeardAt,
    reviewers: review.reviewers.map((reviewer) => (reviewer.status === "verifying" ? { ...reviewer, status: "completed", current } : reviewer)),
    findings: review.findings.map((finding) => {
      if (!settles || finding.fix?.state !== "fixed") return finding;
      const checks = finding.fix.checks.filter((check) => check.pass === pass);
      if (checks.length === 0) return finding;
      return { ...finding, fix: { ...finding.fix, state: checks.some((check) => check.outcome === "reopened") ? "reopened" : "verified" } };
    }),
  };
}

export const STANCE_VERBS: Record<Stance, string> = { supports: "Backs", challenges: "Challenges", uncertain: "Unsure about" };

function applyEvent(review: Review, event: ReviewEvent): Review {
  switch (event.type) {
    case "configured": {
      if (review.phase !== "setup") throw new ReviewError("The review has started; its setup can't change any more.");
      const { seats, depth, deliberationRounds, maxFindings, ...rest } = event.patch;
      // A preset sets both knobs; a knob set in the same patch wins; the depth is then whichever preset they match.
      const preset = depth === undefined ? undefined : DEPTH_PRESETS[depth];
      const knobs: Knobs = {
        deliberationRounds: deliberationRounds ?? preset?.deliberationRounds ?? review.deliberationRounds,
        maxFindings: maxFindings ?? preset?.maxFindings ?? review.maxFindings,
      };
      // A seat keeps the model seen for it while its agent stays the same.
      const reviewers = seats
        ? withLabels(
            seats.map((seat, index) => {
              const before = review.reviewers[index];
              return { ...reviewerOf(seat, index), model: before?.agent === seat.agent ? before.model : null };
            }),
          )
        : review.reviewers;
      return { ...review, ...rest, ...knobs, depth: depthOf(knobs), reviewers, runner: runnerKindOf(reviewers) };
    }
    case "model-seen": {
      const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
      if (!reviewer) throw new ReviewError(`No reviewer ${event.reviewerId} sits at the council.`);
      if (reviewer.model?.name === event.model.name && reviewer.model.effort === event.model.effort) return review;
      return { ...review, reviewers: withLabels(review.reviewers.map((it) => (it.id === reviewer.id ? { ...it, model: event.model } : it))) };
    }
    case "started": {
      if (review.phase !== "setup") throw new ReviewError(`The review can't start: it is ${review.phase}.`);
      if (seatedReviewers(review).length === 0) throw new ReviewError("Seat at least one reviewer before starting the review.");
      const unnamed = review.reviewers.flatMap((reviewer, index) => (reviewer.enabled && !isRunnableAgent(reviewer.agent) ? [index + 1] : []));
      if (unnamed.length > 0) throw new ReviewError(`Name the Mirador profile for reviewer ${unnamed.join(", ")} before starting the review.`);
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
        findings: review.findings.map((finding) => ({ ...finding, positions: positionsFrom(review, finding, [], event.at) })),
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
    case "ruled": {
      if (review.phase !== "complete" || !review.verdict) throw new ReviewError(`Findings are ruled on once the council has its verdict; the review is ${review.phase}.`);
      const finding = findingOf(review, event.findingId);
      const ruling = event.decision === null ? null : { decision: event.decision, note: event.note, at: event.at };
      if (finding.fix) {
        // Handed off: the note may change, or the finding comes out of the fixes while nobody has fixed it yet.
        if (event.decision === "accepted") return updateFinding(review, finding.id, (it) => ({ ...it, ruling }));
        if (finding.fix.state !== "handed-off" && finding.fix.state !== "reopened") throw new ReviewError(`${finding.id} is ${finding.fix.state} already; its ruling can't change.`);
        return updateFinding(review, finding.id, (it) => ({ ...it, ruling, fix: null }));
      }
      return updateFinding(review, finding.id, (it) => ({ ...it, ruling }));
    }
    case "handoff-written": {
      if (review.phase !== "complete" || !review.verdict) throw new ReviewError(`A hand-off is written once the council has its verdict; the review is ${review.phase}.`);
      if (event.findingIds.length === 0) throw new ReviewError("Accept at least one finding before writing the hand-off.");
      for (const id of event.findingIds) if (findingOf(review, id).ruling?.decision !== "accepted") throw new ReviewError(`${id} isn't accepted.`);
      return { ...review, handoff: { path: event.path, findingIds: event.findingIds, at: event.at } };
    }
    case "fix-requested": {
      if (review.phase !== "complete") throw new ReviewError(`Fixes are asked for once the review is complete; it is ${review.phase}.`);
      if (!review.handoff) throw new ReviewError("Write the hand-off before asking for fixes.");
      const ids = new Set(event.findingIds);
      for (const id of ids) if (!review.handoff.findingIds.includes(id)) throw new ReviewError(`${id} isn't in the hand-off.`);
      // A finding not handed off yet, still waiting for its fix, or reopened is handed (again) to this fixer.
      const fixer = event.profile === undefined ? null : { profile: event.profile, conversationId: null };
      return {
        ...review,
        findings: review.findings.map((finding) =>
          !ids.has(finding.id) || (finding.fix && finding.fix.state !== "reopened" && finding.fix.state !== "handed-off")
            ? finding
            : {
                ...finding,
                fix: {
                  state: "handed-off",
                  handedOffAt: event.at,
                  fixer,
                  problem: null,
                  summary: finding.fix?.summary ?? null,
                  files: finding.fix?.files ?? [],
                  fixedAt: finding.fix?.fixedAt ?? null,
                  checks: finding.fix?.checks ?? [],
                },
              },
        ),
      };
    }
    case "fix-delegated": {
      for (const id of event.findingIds) {
        const fix = findingOf(review, id).fix;
        if (fix?.state !== "handed-off" && fix?.state !== "reopened") throw new ReviewError(`${id} isn't waiting for a fix.`);
        if (fix.fixer?.profile !== event.profile) throw new ReviewError(`${id} was handed to ${fix.fixer ? fix.fixer.profile : "this conversation's agent"}, not ${event.profile}.`);
      }
      const ids = new Set(event.findingIds);
      return {
        ...review,
        findings: review.findings.map((finding) => (ids.has(finding.id) ? { ...finding, fix: { ...finding.fix!, fixer: { profile: event.profile, conversationId: event.conversationId } } } : finding)),
      };
    }
    case "fix-failed": {
      const ids = new Set(event.findingIds);
      for (const id of ids) findingOf(review, id);
      return {
        ...review,
        findings: review.findings.map((finding) =>
          ids.has(finding.id) && finding.fix && (finding.fix.state === "handed-off" || finding.fix.state === "reopened") ? { ...finding, fix: { ...finding.fix, problem: event.reason } } : finding,
        ),
      };
    }
    case "fix-reported": {
      if (review.phase !== "complete" && review.phase !== "verification") throw new ReviewError(`A fix is reported after the verdict; the review is ${review.phase}.`);
      const finding = findingOf(review, event.findingId);
      if (!finding.fix) throw new ReviewError(`${finding.id} wasn't handed off for fixing.`);
      if (review.phase === "verification" && finding.fix.state === "fixed") throw new ReviewError(`${finding.id}'s fix is being re-checked; report a change to it once the re-check ends.`);
      if (finding.fix.state === "verified") throw new ReviewError(`${finding.id}'s fix is verified already.`);
      return updateFinding(review, finding.id, (it) => ({ ...it, fix: { ...it.fix!, state: "fixed", problem: null, summary: event.summary, files: event.files, fixedAt: event.at } }));
    }
    case "verification-started": {
      if (review.phase !== "complete") throw new ReviewError(`A verification starts from a complete review; it is ${review.phase}.`);
      if (event.findingIds.length === 0) throw new ReviewError("No fixed finding to re-check.");
      for (const id of event.findingIds) if (findingOf(review, id).fix?.state !== "fixed") throw new ReviewError(`${id} has no fix to re-check.`);
      const checkers = new Set(event.reviewerIds);
      return {
        ...review,
        phase: "verification",
        verifications: review.verifications + 1,
        reviewers: review.reviewers.map((reviewer) =>
          checkers.has(reviewer.id) && reviewer.enabled && reviewer.status === "completed" ? { ...reviewer, status: "verifying", current: "Re-checking fixes" } : reviewer,
        ),
      };
    }
    case "verification-ended": {
      if (review.phase !== "verification") throw new ReviewError(`No verification runs; the review is ${review.phase}.`);
      return endVerification(review, event.at, "Re-check done");
    }
    case "stopped":
    case "interrupted": {
      if (review.phase === "verification") return endVerification(review, event.at, event.type === "stopped" ? "Re-check stopped" : "Re-check interrupted", false);
      if (!isRunning(review)) return review;
      const interruptedPhase = event.type === "interrupted" ? (review.phase as ResumablePhase) : null;
      return { ...review, phase: event.type, endedAt: event.at, reviewers: endActive(review, event.at), interruptedPhase };
    }
    case "resumed":
      return resume(review, event.at);
    case "reviewer-retried": {
      if (review.phase !== "independent-review") throw new ReviewError(`A reviewer is retried during the independent review; the review is ${review.phase}.`);
      const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
      if (!reviewer || !reviewer.enabled) throw new ReviewError(`No reviewer ${event.reviewerId} takes part in the review.`);
      if (reviewer.status !== "failed") throw new ReviewError(`${reviewer.label} hasn't failed; only a failed reviewer is retried.`);
      const retried = updateReviewer(review, reviewer.id, (it) => ({
        ...withActivity(it, { at: event.at, kind: "status", text: "Retrying" }),
        status: "waiting",
        current: "Waiting to retry",
        problem: null,
        startedAt: null,
        endedAt: null,
      }));
      return { ...retried, findings: review.findings.filter((finding) => finding.reviewerId !== reviewer.id) };
    }
    case "findings-merged": {
      const grouping = review.phase === "deliberation" && review.round === 0;
      if (review.phase !== "independent-review" && !grouping) throw new ReviewError(`Findings are merged after the independent review, before the first round; the review is ${review.phase}.`);
      if (seatedReviewers(review).some((reviewer) => reviewer.status === "waiting" || reviewer.status === "reviewing")) {
        throw new ReviewError("Findings can't merge while reviewers are still reviewing.");
      }
      const into = findingOf(review, event.into);
      const merged = event.merged.map((id) => findingOf(review, id));
      if (merged.length === 0 || merged.some((finding) => finding.id === into.id)) throw new ReviewError("Merge other findings into a finding.");
      const severity = [into, ...merged].map((finding) => finding.severity).sort((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b))[0]!;
      const seen = new Set(into.evidence.map(evidenceKey));
      const evidence = [...into.evidence];
      for (const piece of merged.flatMap((finding) => finding.evidence)) {
        if (!seen.has(evidenceKey(piece))) (seen.add(evidenceKey(piece)), evidence.push(piece));
      }
      const why = { ...(event.by === undefined ? {} : { mergedBy: event.by }), ...(event.reason === undefined ? {} : { reason: event.reason }) };
      const reports = merged.flatMap((finding): CoReport[] => [
        { reviewerId: finding.reviewerId, findingId: finding.id, title: finding.title, severity: finding.severity, evidence: finding.evidence, ...why },
        ...finding.alsoReported,
      ]);
      const gone = new Set(event.merged);
      const next: Review = {
        ...review,
        findings: review.findings.filter((finding) => !gone.has(finding.id)).map((finding) => (finding.id === into.id ? { ...finding, severity, evidence, alsoReported: [...finding.alsoReported, ...reports] } : finding)),
      };
      // In the deliberation the co-reporters back the finding from round 0, as its reporter does.
      const positioned = grouping ? updateFinding(next, into.id, (finding) => ({ ...finding, positions: positionsFrom(next, finding, [], event.at) })) : next;
      const grouper = event.by === undefined ? undefined : review.reviewers.find(({ id }) => id === event.by);
      if (!grouper || !isActive(grouper)) return positioned;
      const text = `Merged ${event.merged.join(", ")} into ${into.id}${event.reason ? `: ${event.reason}` : ""}`;
      return updateReviewer(positioned, grouper.id, (it) => withActivity(it, { at: event.at, kind: "finding", text }));
    }
    case "findings-capped": {
      if (review.phase !== "independent-review") throw new ReviewError(`Findings are capped in the independent review; the review is ${review.phase}.`);
      const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
      if (!reviewer || !reviewer.enabled) throw new ReviewError(`No reviewer ${event.reviewerId} takes part in the review.`);
      if (event.findingIds.length === 0) return review;
      for (const id of event.findingIds) if (findingOf(review, id).reviewerId !== reviewer.id) throw new ReviewError(`${id} isn't ${reviewer.label}'s finding.`);
      const gone = new Set(event.findingIds);
      const text = `Kept its ${review.maxFindings} most severe finding${review.maxFindings === 1 ? "" : "s"}; dropped ${event.findingIds.join(", ")}`;
      const capped = updateReviewer(review, reviewer.id, (it) => withActivity(it, { at: event.at, kind: "note", text }));
      return { ...capped, findings: review.findings.filter((finding) => !gone.has(finding.id)) };
    }
    case "duplicates-checked": {
      if (review.phase !== "deliberation" || review.round !== 0) throw new ReviewError(`Findings are grouped before the first round; the review is ${review.phase}.`);
      return review.duplicatesChecked ? review : { ...review, duplicatesChecked: true };
    }
    case "reviewer-removed": {
      if (review.phase === "setup") throw new ReviewError("Before the start, remove a seat in the setup.");
      const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
      if (!reviewer || !reviewer.enabled) throw new ReviewError(`No reviewer ${event.reviewerId} takes part in the review.`);
      if (reviewer.status !== "failed") throw new ReviewError(`${reviewer.label} hasn't failed; only a failed reviewer is removed.`);
      const removed = updateReviewer(review, reviewer.id, (it) => ({ ...withActivity(it, { at: event.at, kind: "status", text: "Removed from the council" }), enabled: false }));
      const unweighed = review.phase === "independent-review" || (review.phase === "interrupted" && review.interruptedPhase === "independent-review");
      const findings = unweighed ? removed.findings.filter((finding) => finding.reviewerId !== reviewer.id) : removed.findings;
      return {
        ...removed,
        // Who ran the reviewers follows the seats while only they authored the findings; later the removed seat's stay.
        runner: unweighed ? runnerKindOf(removed.reviewers) : review.runner,
        findings: findings.map((finding) => ({ ...finding, positions: finding.positions.filter((position) => position.reviewerId !== reviewer.id) })),
      };
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
        id: `F${review.findingsIssued + 1}`,
        reviewerId: reviewer.id,
        status: "reported",
        reportedAt: event.at,
        positions: [],
        resolution: null,
        proposal: null,
        ruling: null,
        fix: null,
        alsoReported: [],
      };
      const reported = updateReviewer(review, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "finding", text: `Reported ${finding.id}: ${finding.title}`, ...(finding.evidence[0] ? { path: finding.evidence[0].path } : {}) }),
      );
      return { ...reported, findings: [...review.findings, finding], findingsIssued: review.findingsIssued + 1 };
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
    case "fix-proposed": {
      if (review.phase !== "synthesis") throw new ReviewError(`Fixes are proposed in the synthesis; the review is in ${review.phase}.`);
      const finding = findingOf(review, event.proposal.findingId);
      if (!finding.resolution || finding.status === "withdrawn") throw new ReviewError(`${finding.id} doesn't stand; it needs no fix.`);
      const { findingId: _, ...proposal } = event.proposal;
      const proposed = updateFinding(review, finding.id, (it) => ({ ...it, proposal: { ...proposal, drafterId: reviewer.id, at: event.at } }));
      return updateReviewer(proposed, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "proposal", text: `Proposed a fix for ${finding.id}: ${proposal.summary}`, ...(proposal.files[0] ? { path: proposal.files[0] } : {}) }),
      );
    }
    case "fix-checked": {
      const finding = findingOf(review, event.check.findingId);
      if (finding.fix?.state !== "fixed") throw new ReviewError(`${finding.id} has no fix to re-check.`);
      const { findingId: _, ...check } = event.check;
      const checked = updateFinding(review, finding.id, (it) => ({
        ...it,
        fix: { ...it.fix!, checks: [...it.fix!.checks.filter((each) => !(each.reviewerId === reviewer.id && each.pass === review.verifications)), { ...check, reviewerId: reviewer.id, pass: review.verifications, at: event.at }] },
      }));
      const verb = check.outcome === "verified" ? "Verified" : "Reopened";
      return updateReviewer(checked, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "check", text: `${verb} ${finding.id}'s fix: ${finding.title}`, ...(check.evidence[0] ? { path: check.evidence[0].path } : {}) }),
      );
    }
    case "reviewer-finished": {
      const current = event.outcome === "completed" ? "Review complete" : event.outcome === "failed" ? "Failed" : "Stopped";
      return updateReviewer(review, reviewer.id, (it) => ({ ...it, status: event.outcome, current, endedAt: event.at, problem: event.problem ?? null }));
    }
  }
}

const evidenceKey = (evidence: Evidence) => `${evidence.path}:${evidence.line ?? ""}-${evidence.endLine ?? ""}`;

/**
 * A review a restart cut short, back in the phase it was in, with the work that was in flight dropped so it can be done
 * again: in the independent review, the unfinished reviewers wait to start over without their findings; in a round,
 * that round's arguments go and it starts again; in the synthesis, the settling and the proposals go.
 */
function resume(review: Review, at: number): Review {
  if (review.phase !== "interrupted" || review.interruptedPhase === null) throw new ReviewError(`Only a review a restart cut short can resume; this one is ${review.phase}.`);
  const phase = review.interruptedPhase;
  const cutShort = (reviewer: Reviewer) => reviewer.enabled && reviewer.status === "stopped";
  const base: Review = { ...review, endedAt: null, interruptedPhase: null, agentHeardAt: null };
  if (phase === "independent-review") {
    const redo = new Set(review.reviewers.filter(cutShort).map(({ id }) => id));
    return {
      ...base,
      phase,
      findings: review.findings.filter((finding) => !redo.has(finding.reviewerId)),
      reviewers: review.reviewers.map((reviewer) =>
        redo.has(reviewer.id) ? { ...withActivity(reviewer, { at, kind: "status", text: "Resuming after a restart" }), status: "waiting", current: "Waiting to resume", startedAt: null, endedAt: null } : reviewer,
      ),
    };
  }
  const back = review.reviewers.map((reviewer) => (cutShort(reviewer) ? { ...reviewer, status: "deliberating" as const, current: "Resuming after a restart", endedAt: null } : reviewer));
  if (phase === "deliberation") {
    // The cut-short round starts again; the engine starts it anew from the round before.
    const args = review.arguments.filter((argument) => argument.round < review.round);
    return {
      ...base,
      phase,
      round: Math.max(0, review.round - 1),
      reviewers: back,
      arguments: args,
      findings: review.findings.map((finding) => ({ ...finding, positions: positionsFrom(review, finding, args, at) })),
    };
  }
  // The synthesis starts again after the last round.
  return {
    ...base,
    phase: "deliberation",
    round: review.rounds,
    reviewers: back,
    findings: review.findings.map((finding) => ({ ...finding, status: "reported", resolution: null, proposal: null })),
  };
}

/** Applies one event; the review it gives back has the next sequence number unless the event changed nothing. */
export function reduce(review: Review, event: ReviewEvent): Review {
  const next = applyEvent(review, event);
  return next === review ? review : { ...next, seq: review.seq + 1 };
}
