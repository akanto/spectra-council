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
import { agentLabel, choiceOf, isRunnableAgent, runnerKindOf, sameChoice, seatOf, withLabels } from "./agents.ts";
import { verdictSummary } from "./deliberation.ts";
import { DEPTH_PRESETS, depthOf, knobsProblem, overLimit, presetsOf, type DepthChoice, type Knobs } from "./depth.ts";
import {
  MAX_ACTIVITY,
  REVIEW_FORMAT,
  isActive,
  isRunning,
  seatedReviewers,
  type Activity,
  type ActivityKind,
  type Argument,
  type Ask,
  type Claim,
  type ClaimDecision,
  type ClaimStatus,
  type Debated,
  type Research,
  type CoReport,
  type Decision,
  type Dissent,
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
import { currentClaims } from "./research.ts";
import {
  SEVERITIES,
  type ArgumentInput,
  type ClaimInput,
  type DraftObjectionInput,
  type Evidence,
  type FindingInput,
  type FixCheckInput,
  type ProposalInput,
  type Seat,
  type Setup,
  type SetupPatch,
  type SourceCheckInput,
} from "./schemas.ts";

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
  /** Research: a claim a seat reports in its own research of the brief (or of the follow-up question). */
  | { type: "claim-reported"; reviewerId: string; at: number; claim: ClaimInput }
  /** Research: a seat's check of a source of a claim it was given to check, at the start of the deliberation. */
  | { type: "source-checked"; reviewerId: string; at: number; check: SourceCheckInput }
  /** Research: the editor's draft of the answer, with what the plugin found wrong with it (`draftProblems`). */
  | { type: "answer-drafted"; reviewerId: string; at: number; markdown: string; problems: string[] }
  /** Research: a seat's objection to a sentence of the latest draft, in the council's check of it. */
  | { type: "draft-objected"; reviewerId: string; at: number; objection: DraftObjectionInput }
  | { type: "reviewer-finished"; reviewerId: string; at: number; outcome: ReviewerOutcome; problem?: string };

/**
 * A seat that failed its own review takes the reply its conversation gave after all, fetched late from the conversation
 * the seat gave up on (`conversationId`): the reply's prose (`note`), its findings, checked, and why any were rejected.
 * The seat is completed with those findings, as if its turn had ended in time. During the independent review they are
 * its review's findings; on a complete review that doesn't reopen (`reopened`) they come in `late`, the council never
 * weighs them, and the verdict is written again to count them.
 */
export interface ReplyFetched {
  type: "reply-fetched";
  reviewerId: string;
  at: number;
  conversationId: string;
  note: string | null;
  findings: FindingInput[];
  rejected: string[];
}

export type ReviewEvent =
  | ReviewerEvent
  | ReplyFetched
  /**
   * A complete review that ended without a deliberation goes back to the end of its independent review, to go on from
   * there as a run does (merging, grouping, rounds, synthesis, verdict): a late reply brought a second reviewer's
   * findings in. Only before anything was done with its verdict (`whyNoReopen`).
   */
  | { type: "reopened"; at: number }
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
   * The model a profile seat runs on, as the host learnt it: before the start, the profile's model, else what its latest
   * conversation ran on; once a turn started, what its conversation runs on. Relabels the seat by its model.
   */
  | { type: "model-seen"; reviewerId: string; model: ModelInfo }
  | { type: "started"; at: number }
  /** The independent review is over and the findings go on the table: the reviewers who finished it take part. */
  | { type: "deliberation-started"; at: number; rounds: number }
  | { type: "round-started"; at: number; round: number }
  | { type: "synthesis-started"; at: number }
  | { type: "finding-resolved"; at: number; findingId: string; status: Exclude<FindingStatus, "reported">; rationale: string; dissenters: string[]; dissent?: Dissent[] }
  /** The review ends with the council's verdict. */
  | { type: "concluded"; at: number; summary: string }
  /**
   * The user's decision on a finding after the verdict; null clears it. A finding handed off but not fixed yet can still
   * be dismissed or deferred, which takes it out of the fixes.
   */
  | { type: "ruled"; at: number; findingId: string; decision: Decision | null; note: string }
  /** The hand-off document of these (accepted) findings was written to `path`. */
  | { type: "handoff-written"; at: number; path: string; findingIds: string[]; digest?: string }
  /**
   * The agent was asked to fix these accepted findings, by the hand-off: this conversation's, or another profile's. Only
   * those that await a request (awaitsFixRequest) change hands; one waiting for or with its fixer stays as it is.
   */
  | { type: "fix-requested"; at: number; findingIds: string[]; profile?: string }
  /** A conversation was started on the fixer's profile to fix these findings. */
  | { type: "fix-delegated"; at: number; findingIds: string[]; profile: string; conversationId: string }
  /** The fixer didn't fix these findings: what it said, or how its turn ended. */
  | { type: "fix-failed"; at: number; findingIds: string[]; reason: string }
  /**
   * The agent says it fixed the finding: what it changed, and where. An accepted finding nobody handed off (fixed on the
   * user's own ask) gets its fix with it.
   */
  | { type: "fix-reported"; at: number; findingId: string; summary: string; files: string[] }
  /** The agent was asked to file a beads issue for each of these accepted findings. */
  | { type: "tickets-requested"; at: number; findingIds: string[] }
  /** The agent filed a beads issue for an accepted finding, under this id. */
  | { type: "ticketed"; at: number; findingId: string; ticket: string }
  /**
   * The user asked the agent, in their own words, to do something about these accepted findings: this conversation's,
   * or, with `profile`, the fixer profile's in a conversation of its own.
   */
  | { type: "asked"; at: number; text: string; findingIds: string[]; profile?: string }
  /** A conversation was started on the fixer's profile for the ask at this index of `asks`. */
  | { type: "ask-delegated"; at: number; ask: number; conversationId: string }
  /** The fixer's conversation for the ask at this index ended its turn: with a usable report, or with this problem. */
  | { type: "ask-answered"; at: number; ask: number; problem: string | null }
  /** The fixer's conversation for the ask at this index couldn't be started: why. The ask ends unanswered. */
  | { type: "ask-failed"; at: number; ask: number; problem: string }
  /** These reviewers re-check these fixed findings. */
  | { type: "verification-started"; at: number; findingIds: string[]; reviewerIds: string[] }
  /** Each finding checked in this round is verified, or reopened if any check reopened it. */
  | { type: "verification-ended"; at: number }
  | { type: "stopped"; at: number }
  /** The host lost the run, as when Mirador restarted while it went on. */
  | { type: "interrupted"; at: number }
  /** Research: a researcher's claims past the limit (`maxFindings`), the least telling, are dropped. */
  | { type: "claims-capped"; reviewerId: string; at: number; claimIds: string[] }
  /** Research: claims that state the same thing merge into `into`, by the grouping turn's agent (`by`). */
  | { type: "claims-merged"; at: number; into: string; merged: string[]; by?: string; reason?: string }
  /** Research: the source check at the start of the deliberation is over. */
  | { type: "sources-checked"; at: number }
  /** Research: the synthesis settles a claim of the current run. */
  | { type: "claim-resolved"; at: number; claimId: string; status: Exclude<ClaimStatus, "reported">; rationale: string; dissenters: string[]; dissent?: Dissent[] }
  /** Research: the plugin wrote the answer (the latest draft and the ledger) to `path`. */
  | { type: "answer-written"; at: number; path: string; digest: string }
  /** Research: the user sends the council back with a question; it waits for a start (`follow-up-started`). */
  | { type: "follow-up-asked"; at: number; question: string }
  /** Research: the waiting follow-up's run starts: the seats that completed research it, as a new run. */
  | { type: "follow-up-started"; at: number }
  /** Research: the user keeps or strikes a claim (null clears it); a change to what the answer may state makes a revision due. */
  | { type: "claim-ruled"; at: number; claimId: string; decision: ClaimDecision | null; note: string }
  /** Research: the editor revises the answer after the user's rulings; the council is back in its synthesis till it's written. */
  | { type: "revision-started"; at: number }
  /** The host's agent was told how the review ended. */
  | { type: "agent-heard"; at: number }
  /** The telling was lost before it reached the agent: the ended note may carry the review again. */
  | { type: "agent-unheard" };

const withAsk = (review: Review, index: number, ask: Ask): Review => ({ ...review, asks: (review.asks ?? []).map((each, at) => (at === index ? ask : each)) });

/**
 * Whether asking for fixes hands this finding (again) to a fixer: it has no fix yet, the council's re-check reopened
 * its fix, or its fixer didn't fix it (said so, or ended without saying). A hand-off that waits for its fixer or is
 * being worked on stays with whoever has it, so a second request can't start overlapping work; a fixed or verified one
 * has nothing to hand off.
 */
export const awaitsFixRequest = (finding: Finding): boolean =>
  !finding.fix || finding.fix.state === "reopened" || (finding.fix.state === "handed-off" && finding.fix.problem !== null);

/** Whether the user asked the agent about this finding in their own words (an `asked` event). */
const askedAbout = (review: Review, findingId: string) => (review.asks ?? []).some((ask) => ask.findingIds.includes(findingId));

/** Thrown for an event the review can't take now; its message says why, for whoever sent it. */
export class ReviewError extends Error {}

/**
 * Why a complete review can't go back to its deliberation, or null when it can: it ended without one, and nobody has
 * ruled on, handed off, ticketed, asked about or re-checked its findings since.
 */
export function whyNoReopen(review: Review): string | null {
  if (review.research) return "A research council doesn't reopen; send it back with a follow-up.";
  if (review.phase !== "complete") return `Only a complete review reopens; this one is ${review.phase}.`;
  if (review.rounds > 0) return "The council deliberated this review already.";
  const touched = review.verifications > 0 || review.handoff !== null || (review.asks?.length ?? 0) > 0 || review.findings.some((finding) => finding.ruling || finding.fix || finding.ticket);
  if (touched) return "Its findings were ruled on or handed off since the verdict.";
  return null;
}

/**
 * Whether taking this late reply reopens the review for its deliberation: it can reopen, and with the reply at least two
 * seated reviewers will have finished their review, with a finding between them.
 */
export function reopensWith(review: Review, fetched: ReplyFetched): boolean {
  if (whyNoReopen(review) !== null) return false;
  const finished = seatedReviewers(review).filter((reviewer) => reviewer.status === "completed" || reviewer.id === fetched.reviewerId).length;
  return finished >= 2 && review.findings.length + fetched.findings.length > 0;
}

const reviewerOf = (seat: Seat, index: number): Reviewer => {
  const choice = choiceOf(seat);
  return {
    id: `r${index + 1}`,
    agent: seat.agent,
    label: agentLabel(seat.agent),
    model: null,
    ...(choice ? { choice } : {}),
    ...(seat.focus ? { focus: seat.focus } : {}),
    enabled: seat.enabled,
    status: "idle",
    current: null,
    activity: [],
    activityCount: 0,
    startedAt: null,
    endedAt: null,
    problem: null,
  };
};

/** The knobs a setup asks for: its depth preset's, with any knob it sets itself. */
const knobsOf = (setup: Pick<Setup, "depth" | "deliberationRounds" | "maxFindings" | "kind">): Knobs => ({
  deliberationRounds: setup.deliberationRounds ?? presetsOf(setup.kind)[setup.depth].deliberationRounds,
  maxFindings: setup.maxFindings ?? presetsOf(setup.kind)[setup.depth].maxFindings,
});

/** A research council's state before its start. */
const newResearch = (setup: Pick<Setup, "brief" | "question" | "answerFile" | "editor">): Research => ({
  brief: setup.brief,
  question: setup.question,
  answerFile: setup.answerFile,
  editor: setup.editor,
  claims: [],
  claimsIssued: 0,
  pass: 0,
  followUps: [],
  sourcesChecked: false,
  drafts: [],
  objections: [],
  written: null,
  revisionDue: false,
});

/** The research fields of a setup, which a review's setup may leave out. */
type ResearchSetup = "kind" | "brief" | "question" | "answerFile" | "editor";

/** A setup as a caller gives it: a review's may leave out the kind (a review) and the research fields. */
export type NewSetup = Omit<Setup, ResearchSetup> & Partial<Pick<Setup, ResearchSetup>>;

/** Throws, saying why, when a setup's knobs don't fit its kind of council. */
export function newReview(id: string, given: NewSetup, runner: RunnerKind, at: number): Review {
  const setup: Setup = { kind: "review", brief: "", question: "", answerFile: "", editor: "r1", ...given };
  const knobs = knobsOf(setup);
  const problem = knobsProblem(setup.kind, knobs);
  if (problem) throw new ReviewError(problem);
  return {
    format: REVIEW_FORMAT,
    id,
    kind: setup.kind,
    ...(setup.kind === "research" ? { research: newResearch(setup) } : {}),
    target: setup.target,
    profile: setup.profile,
    depth: depthOf(knobs, setup.kind),
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
    stoppedPhase: null,
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
    // Format 8 and before knew only reviews.
    kind: (old as Partial<Review>).kind ?? "review",
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
  seats: review.reviewers.map(seatOf),
  kind: review.kind,
  brief: review.research?.brief ?? "",
  question: review.research?.question ?? "",
  answerFile: review.research?.answerFile ?? "",
  editor: review.research?.editor ?? "r1",
});

const withResearch = (review: Review, update: (research: Research) => Research): Review => {
  if (!review.research) throw new ReviewError("This council researches nothing; it is a review.");
  return { ...review, research: update(review.research) };
};

const updateClaim = (review: Review, claimId: string, update: (claim: Claim) => Claim): Review =>
  withResearch(review, (research) => ({ ...research, claims: research.claims.map((claim) => (claim.id === claimId ? update(claim) : claim)) }));

const claimOf = (review: Review, claimId: string): Claim => {
  const claim = review.research?.claims.find(({ id }) => id === claimId);
  if (!claim) throw new ReviewError(`There is no claim ${claimId}.`);
  return claim;
};

/** A research council's claims of the current run with their positions from these arguments, as `positionsFrom` gives a finding's. */
const claimsPositioned = (review: Review, args: Argument[], at: number): Review =>
  !review.research
    ? review
    : withResearch(review, (research) => ({
        ...research,
        claims: research.claims.map((claim) => (claim.pass === research.pass ? { ...claim, positions: positionsFrom(review, claim, args, at) } : claim)),
      }));

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
function positionsFrom(review: Review, finding: Debated, args: Argument[], at: number): Position[] {
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
 * reopened it; one put to it that got no check stays fixed, with the problem saying so. A cut-short round settles nothing. The agent hears of the outcome anew.
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
      // Put to this pass and no check came back (its checkers' turns failed, or left it out): it stays fixed, saying why.
      if (checks.length === 0) return finding.fix.recheckedIn === pass ? { ...finding, fix: { ...finding.fix, problem: `No reviewer re-checked it in re-check ${pass}: their turns failed or left it out (their activity says which). Re-check it again.` } } : finding;
      return { ...finding, fix: { ...finding.fix, state: checks.some((check) => check.outcome === "reopened") ? "reopened" : "verified" } };
    }),
  };
}

export const STANCE_VERBS: Record<Stance, string> = { supports: "Backs", challenges: "Challenges", uncertain: "Unsure about" };

function applyEvent(review: Review, event: ReviewEvent): Review {
  switch (event.type) {
    case "configured": {
      if (review.phase !== "setup") throw new ReviewError("The review has started; its setup can't change any more.");
      const { seats, depth, deliberationRounds, maxFindings, brief, question, answerFile, editor, ...rest } = event.patch;
      // A preset sets both knobs; a knob set in the same patch wins; the depth is then whichever preset they match.
      const preset = depth === undefined ? undefined : presetsOf(review.kind)[depth];
      const knobs: Knobs = {
        deliberationRounds: deliberationRounds ?? preset?.deliberationRounds ?? review.deliberationRounds,
        maxFindings: maxFindings ?? preset?.maxFindings ?? review.maxFindings,
      };
      // A seat keeps the model seen for it while its agent and its choice of model and effort stay the same.
      const reviewers = seats
        ? withLabels(
            seats.map((seat, index) => {
              const before = review.reviewers[index];
              const after = reviewerOf(seat, index);
              return { ...after, model: before?.agent === seat.agent && sameChoice(before.choice, after.choice) ? before.model : null };
            }),
          )
        : review.reviewers;
      const problem = knobsProblem(review.kind, knobs);
      if (problem) throw new ReviewError(problem);
      const researchPatch = { brief, question, answerFile, editor };
      const research = review.research
        ? { ...review.research, ...Object.fromEntries(Object.entries(researchPatch).filter(([, value]) => value !== undefined)) }
        : undefined;
      if (!research && Object.values(researchPatch).some((value) => value !== undefined)) throw new ReviewError("A review has no brief, question, answer file or editor; those are a research council's.");
      return { ...review, ...rest, ...knobs, depth: depthOf(knobs, review.kind), reviewers, runner: runnerKindOf(reviewers), ...(research ? { research } : {}) };
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
      if (review.research) {
        if (!review.research.brief.trim() && !review.research.question.trim()) throw new ReviewError("Give the council a brief file or a question to research before starting it.");
        if (!seatedReviewers(review).some((reviewer) => reviewer.id === review.research!.editor)) throw new ReviewError(`The editor, ${review.research.editor.toUpperCase()}, isn't a seat at the council; pick one that is.`);
      }
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
      // A research council goes on to its answer without rounds when fewer than two seats finished: rounds 0.
      if (event.rounds < (review.research ? 0 : 1)) throw new ReviewError("A deliberation has at least one round.");
      const deliberating: Review = {
        ...review,
        phase: "deliberation",
        round: 0,
        rounds: event.rounds,
        reviewers: review.reviewers.map((reviewer) =>
          reviewer.enabled && reviewer.status === "completed" ? { ...reviewer, status: "deliberating", current: review.research ? "Reading the other claims" : "Reading the other findings" } : reviewer,
        ),
        findings: review.findings.map((finding) => ({ ...finding, positions: positionsFrom(review, finding, [], event.at) })),
      };
      return claimsPositioned(deliberating, [], event.at);
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
      const { status, rationale, dissenters, dissent, at } = event;
      return updateFinding(review, event.findingId, (finding) => ({ ...finding, status, resolution: { status, rationale, dissenters, ...(dissent ? { dissent } : {}), at } }));
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
      // A ticket asked for and not filed yet goes when the finding is no longer accepted; a filed one stays on record.
      const ticket = event.decision !== "accepted" && finding.ticket && finding.ticket.id === null ? { ticket: null } : {};
      if (finding.fix) {
        // Handed off: the note may change, or the finding comes out of the fixes while nobody has fixed it yet.
        if (event.decision === "accepted") return updateFinding(review, finding.id, (it) => ({ ...it, ruling }));
        if (finding.fix.state !== "handed-off" && finding.fix.state !== "reopened") throw new ReviewError(`${finding.id} is ${finding.fix.state} already; its ruling can't change.`);
        return updateFinding(review, finding.id, (it) => ({ ...it, ruling, fix: null, ...ticket }));
      }
      return updateFinding(review, finding.id, (it) => ({ ...it, ruling, ...ticket }));
    }
    case "handoff-written": {
      if (review.phase !== "complete" || !review.verdict) throw new ReviewError(`A hand-off is written once the council has its verdict; the review is ${review.phase}.`);
      if (event.findingIds.length === 0) throw new ReviewError("Accept at least one finding before writing the hand-off.");
      for (const id of event.findingIds) if (findingOf(review, id).ruling?.decision !== "accepted") throw new ReviewError(`${id} isn't accepted.`);
      return { ...review, handoff: { path: event.path, findingIds: event.findingIds, at: event.at, ...(event.digest ? { digest: event.digest } : {}) } };
    }
    case "fix-requested": {
      if (review.phase !== "complete") throw new ReviewError(`Fixes are asked for once the review is complete; it is ${review.phase}.`);
      if (!review.handoff) throw new ReviewError("Write the hand-off before asking for fixes.");
      const ids = new Set(event.findingIds);
      for (const id of ids) if (!review.handoff.findingIds.includes(id)) throw new ReviewError(`${id} isn't in the hand-off.`);
      // A finding not handed off yet, reopened, or whose fixer failed is handed (again) to this fixer as its new owner,
      // so a late report from the attempt it replaces no longer matches it. One waiting for or with its fixer keeps it.
      const fixer = event.profile === undefined ? null : { profile: event.profile, conversationId: null };
      return {
        ...review,
        findings: review.findings.map((finding) =>
          !ids.has(finding.id) || !awaitsFixRequest(finding)
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
        if (fix?.state !== "handed-off") throw new ReviewError(`${id} isn't waiting for a fix.`);
        if (fix.fixer?.profile !== event.profile) throw new ReviewError(`${id} was handed to ${fix.fixer ? fix.fixer.profile : "this conversation's agent"}, not ${event.profile}.`);
        // Its owner keeps it: only a new request, once that one failed, hands it to another conversation.
        if (fix.fixer.conversationId !== null) throw new ReviewError(`${id} is with ${event.profile}'s conversation ${fix.fixer.conversationId} already.`);
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
        findings: review.findings.map((finding) => {
          if (!ids.has(finding.id)) return finding;
          if (finding.fix) return finding.fix.state === "handed-off" || finding.fix.state === "reopened" ? { ...finding, fix: { ...finding.fix, problem: event.reason } } : finding;
          // An accepted finding nobody handed off, which the user asked a fixer about in their own words: why it wasn't
          // fixed gets a fix to show on, one that awaits a fix request like any other its fixer didn't fix.
          if (finding.ruling?.decision !== "accepted" || !askedAbout(review, finding.id)) return finding;
          return { ...finding, fix: { state: "handed-off", handedOffAt: event.at, fixer: null, problem: event.reason, summary: null, files: [], fixedAt: null, checks: [] } };
        }),
      };
    }
    case "fix-reported": {
      if (review.phase !== "complete" && review.phase !== "verification") throw new ReviewError(`A fix is reported after the verdict; the review is ${review.phase}.`);
      const finding = findingOf(review, event.findingId);
      if (!finding.fix) {
        // Only a finding the user asked the agent about in their own words, accepted, may be fixed without a hand-off.
        // During a re-check too: the fixer's reply to an ask may come while one runs; the finding isn't being re-checked.
        if (finding.ruling?.decision !== "accepted" || !askedAbout(review, finding.id)) throw new ReviewError(`${finding.id} wasn't handed off for fixing.`);
        const fix = { state: "fixed" as const, handedOffAt: event.at, fixer: null, problem: null, summary: event.summary, files: event.files, fixedAt: event.at, checks: [] };
        return updateFinding(review, finding.id, (it) => ({ ...it, fix }));
      }
      if (review.phase === "verification" && finding.fix.state === "fixed") throw new ReviewError(`${finding.id}'s fix is being re-checked; report a change to it once the re-check ends.`);
      if (finding.fix.state === "verified") throw new ReviewError(`${finding.id}'s fix is verified already.`);
      return updateFinding(review, finding.id, (it) => ({ ...it, fix: { ...it.fix!, state: "fixed", problem: null, summary: event.summary, files: event.files, fixedAt: event.at } }));
    }
    case "tickets-requested": {
      if (review.phase !== "complete") throw new ReviewError(`Tickets are asked for once the review is complete; it is ${review.phase}.`);
      if (event.findingIds.length === 0) throw new ReviewError("No accepted finding to file a ticket for.");
      for (const id of event.findingIds) if (findingOf(review, id).ruling?.decision !== "accepted") throw new ReviewError(`${id} isn't accepted.`);
      const ids = new Set(event.findingIds);
      // A filed ticket stays; one asked for before and never reported is asked for again.
      return {
        ...review,
        findings: review.findings.map((finding) => (ids.has(finding.id) && !finding.ticket?.id ? { ...finding, ticket: { id: null, requestedAt: event.at, filedAt: null } } : finding)),
      };
    }
    case "ticketed": {
      // During a re-check too: the agent or a fixer may report one while it runs.
      if (review.phase !== "complete" && review.phase !== "verification") throw new ReviewError(`A ticket is recorded once the review is complete; it is ${review.phase}.`);
      const finding = findingOf(review, event.findingId);
      const ticket = event.ticket.trim();
      if (!ticket) throw new ReviewError("A ticket needs its issue id.");
      if (finding.ruling?.decision !== "accepted") throw new ReviewError(`${finding.id} isn't accepted.`);
      if (!finding.ticket && !askedAbout(review, finding.id)) throw new ReviewError(`No ticket was asked for ${finding.id}.`);
      return updateFinding(review, finding.id, (it) => ({ ...it, ticket: { id: ticket, requestedAt: it.ticket?.requestedAt ?? event.at, filedAt: event.at } }));
    }
    case "asked": {
      if (review.phase !== "complete") throw new ReviewError(`The agent is asked about the findings once the review is complete; it is ${review.phase}.`);
      const text = event.text.trim();
      if (!text) throw new ReviewError("Say what to ask the agent.");
      if (event.findingIds.length === 0) throw new ReviewError("Accept at least one finding before asking about them.");
      for (const id of event.findingIds) if (findingOf(review, id).ruling?.decision !== "accepted") throw new ReviewError(`${id} isn't accepted.`);
      const profile = event.profile?.trim();
      const fixer = profile ? { fixer: { profile, conversationId: null, endedAt: null, problem: null } } : {};
      // A new ask for the fixer replaces one never started (its profile was wrong, or the agent didn't start it).
      const asks = (review.asks ?? []).map((ask) =>
        profile && ask.fixer && ask.fixer.conversationId === null && ask.fixer.endedAt === null ? { ...ask, fixer: { ...ask.fixer, endedAt: event.at, problem: "Never started; a later ask replaced it." } } : ask,
      );
      return { ...review, asks: [...asks, { text, findingIds: event.findingIds, at: event.at, ...fixer }] };
    }
    case "ask-delegated": {
      const ask = review.asks?.[event.ask];
      if (!ask?.fixer) throw new ReviewError(`No ask ${event.ask} was sent to a fixer profile.`);
      if (ask.fixer.conversationId !== null) throw new ReviewError(`Ask ${event.ask} was started already.`);
      return withAsk(review, event.ask, { ...ask, fixer: { ...ask.fixer, conversationId: event.conversationId } });
    }
    case "ask-answered": {
      const ask = review.asks?.[event.ask];
      if (!ask?.fixer?.conversationId) throw new ReviewError(`Ask ${event.ask} has no fixer conversation.`);
      return withAsk(review, event.ask, { ...ask, fixer: { ...ask.fixer, endedAt: event.at, problem: event.problem } });
    }
    case "ask-failed": {
      const ask = review.asks?.[event.ask];
      if (!ask?.fixer) throw new ReviewError(`No ask ${event.ask} was sent to a fixer profile.`);
      if (ask.fixer.conversationId !== null || ask.fixer.endedAt !== null) throw new ReviewError(`Ask ${event.ask} isn't waiting to start.`);
      return withAsk(review, event.ask, { ...ask, fixer: { ...ask.fixer, endedAt: event.at, problem: event.problem } });
    }
    case "verification-started": {
      if (review.phase !== "complete") throw new ReviewError(`A verification starts from a complete review; it is ${review.phase}.`);
      if (event.findingIds.length === 0) throw new ReviewError("No fixed finding to re-check.");
      for (const id of event.findingIds) if (findingOf(review, id).fix?.state !== "fixed") throw new ReviewError(`${id} has no fix to re-check.`);
      const checkers = new Set(event.reviewerIds);
      const pass = review.verifications + 1;
      const ids = new Set(event.findingIds);
      return {
        ...review,
        phase: "verification",
        verifications: pass,
        findings: review.findings.map((finding) => (ids.has(finding.id) ? { ...finding, fix: { ...finding.fix!, recheckedIn: pass, problem: null } } : finding)),
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
      const cutIn = review.phase as ResumablePhase;
      const interruptedPhase = event.type === "interrupted" ? cutIn : null;
      const stoppedPhase = event.type === "stopped" ? cutIn : null;
      return { ...review, phase: event.type, endedAt: event.at, reviewers: endActive(review, event.at), interruptedPhase, stoppedPhase };
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
      const withoutFindings = { ...retried, findings: review.findings.filter((finding) => finding.reviewerId !== reviewer.id) };
      return withoutFindings.research
        ? withResearch(withoutFindings, (research) => ({ ...research, claims: research.claims.filter((claim) => !(claim.reviewerId === reviewer.id && claim.pass === research.pass)) }))
        : withoutFindings;
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
      return capped(review, reviewer.id, event.findingIds, event.at);
    }
    case "reply-fetched":
      return takeLateReply(review, event);
    case "reopened": {
      const why = whyNoReopen(review);
      if (why) throw new ReviewError(why);
      // Findings taken in late before are deliberated with the rest now.
      const findings = review.findings.map(({ late: _, ...finding }) => finding);
      return { ...review, phase: "independent-review", verdict: null, endedAt: null, agentHeardAt: null, findings };
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
      const without = {
        ...removed,
        // Who ran the reviewers follows the seats while only they authored the findings; later the removed seat's stay.
        runner: unweighed ? runnerKindOf(removed.reviewers) : review.runner,
        findings: findings.map((finding) => ({ ...finding, positions: finding.positions.filter((position) => position.reviewerId !== reviewer.id) })),
      };
      return without.research
        ? withResearch(without, (research) => ({
            ...research,
            claims: research.claims
              .filter((claim) => !(unweighed && claim.reviewerId === reviewer.id && claim.pass === research.pass))
              .map((claim) => ({ ...claim, positions: claim.positions.filter((position) => position.reviewerId !== reviewer.id) })),
          }))
        : without;
    }
    case "claims-capped": {
      if (review.phase !== "independent-review") throw new ReviewError(`Claims are capped in the research; the council is ${review.phase}.`);
      if (event.claimIds.length === 0) return review;
      for (const id of event.claimIds) if (claimOf(review, id).reviewerId !== event.reviewerId) throw new ReviewError(`${id} isn't ${event.reviewerId}'s claim.`);
      return cappedClaims(review, event.reviewerId, event.claimIds, event.at);
    }
    case "claims-merged": {
      if (review.phase !== "deliberation" || review.round !== 0) throw new ReviewError(`Claims are merged before the first round; the council is ${review.phase}.`);
      const into = claimOf(review, event.into);
      const merged = event.merged.map((id) => claimOf(review, id));
      if (merged.length === 0 || merged.some((claim) => claim.id === into.id)) throw new ReviewError("Merge other claims into a claim.");
      if ([into, ...merged].some((claim) => claim.pass !== review.research!.pass)) throw new ReviewError("Only claims of the current run merge.");
      const why = { ...(event.by === undefined ? {} : { mergedBy: event.by }), ...(event.reason === undefined ? {} : { reason: event.reason }) };
      const sourceKey = (source: Claim["sources"][number]) => (source.doi ?? source.url).toLowerCase();
      const seen = new Set(into.sources.map(sourceKey));
      const sources = [...into.sources];
      for (const source of merged.flatMap((claim) => claim.sources)) if (!seen.has(sourceKey(source))) (seen.add(sourceKey(source)), sources.push(source));
      const reports = merged.flatMap((claim) => [{ reviewerId: claim.reviewerId, claimId: claim.id, title: claim.title, ...why }, ...claim.alsoReported]);
      const gone = new Set(event.merged);
      const next = withResearch(review, (research) => ({
        ...research,
        claims: research.claims.filter((claim) => !gone.has(claim.id)).map((claim) => (claim.id === into.id ? { ...claim, sources, alsoReported: [...claim.alsoReported, ...reports] } : claim)),
      }));
      // The co-reporters back the claim from round 0, as its reporter does.
      const positioned = updateClaim(next, into.id, (claim) => ({ ...claim, positions: positionsFrom(next, claim, [], event.at) }));
      const grouper = event.by === undefined ? undefined : review.reviewers.find(({ id }) => id === event.by);
      if (!grouper || !isActive(grouper)) return positioned;
      return updateReviewer(positioned, grouper.id, (it) => withActivity(it, { at: event.at, kind: "finding", text: `Merged ${event.merged.join(", ")} into ${into.id}${event.reason ? `: ${event.reason}` : ""}` }));
    }
    case "sources-checked": {
      if (review.phase !== "deliberation" || review.round !== 0) throw new ReviewError(`Sources are checked before the first round; the council is ${review.phase}.`);
      return withResearch(review, (research) => (research.sourcesChecked ? research : { ...research, sourcesChecked: true }));
    }
    case "claim-resolved": {
      if (review.phase !== "synthesis") throw new ReviewError(`A claim is settled in the synthesis; the council is ${review.phase}.`);
      const claim = claimOf(review, event.claimId);
      if (claim.pass !== review.research!.pass) throw new ReviewError(`${claim.id} was settled in an earlier run.`);
      const { status, rationale, dissenters, dissent, at } = event;
      return updateClaim(review, claim.id, (it) => ({ ...it, status, resolution: { status, rationale, dissenters, ...(dissent ? { dissent } : {}), at } }));
    }
    case "answer-written": {
      if (!review.research) throw new ReviewError("A review has no answer to write.");
      return withResearch(review, (research) => ({ ...research, written: { path: event.path, at: event.at, digest: event.digest } }));
    }
    case "follow-up-asked": {
      if (review.phase !== "complete" || !review.research) throw new ReviewError(`A follow-up is asked of a research council that has answered; this one is ${review.phase}.`);
      const question = event.question.trim();
      if (!question) throw new ReviewError("Say what the council should look into.");
      // A follow-up asked and never started gives way to the new one.
      const waiting = review.research.followUps.filter((followUp) => followUp.startedAt !== null);
      return withResearch(review, (research) => ({ ...research, followUps: [...waiting, { question, at: event.at, pass: research.pass + 1, startedAt: null }] }));
    }
    case "follow-up-started": {
      if (review.phase !== "complete" || !review.research) throw new ReviewError(`A follow-up starts from a research council that has answered; this one is ${review.phase}.`);
      const followUp = review.research.followUps.at(-1);
      if (!followUp || followUp.startedAt !== null) throw new ReviewError("No follow-up waits to start.");
      const researchers = seatedReviewers(review).filter((reviewer) => reviewer.status === "completed");
      if (researchers.length === 0) throw new ReviewError("No seat that completed the research is left to follow it up.");
      const ids = new Set(researchers.map(({ id }) => id));
      return {
        ...review,
        phase: "independent-review",
        round: 0,
        rounds: 0,
        verdict: null,
        endedAt: null,
        agentHeardAt: null,
        duplicatesChecked: false,
        stoppedPhase: null,
        reviewers: review.reviewers.map((reviewer) =>
          ids.has(reviewer.id) ? { ...withActivity(reviewer, { at: event.at, kind: "status", text: `Following up: ${followUp.question}` }), status: "waiting", current: "Waiting to follow up", problem: null, startedAt: null, endedAt: null } : reviewer,
        ),
        research: {
          ...review.research,
          pass: followUp.pass,
          sourcesChecked: false,
          revisionDue: false,
          followUps: review.research.followUps.map((each) => (each === followUp ? { ...each, startedAt: event.at } : each)),
        },
      };
    }
    case "claim-ruled": {
      if (review.phase !== "complete" || !review.research) throw new ReviewError(`Claims are ruled on once the council has answered; it is ${review.phase}.`);
      const claim = claimOf(review, event.claimId);
      const ruling = event.decision === null ? null : { decision: event.decision, note: event.note, at: event.at };
      const struck = (decision: ClaimDecision | null | undefined) => decision === "struck";
      // Only a strike or its undoing changes what the answer may state.
      const due = struck(claim.ruling?.decision) !== struck(event.decision);
      const ruled = updateClaim(review, claim.id, (it) => ({ ...it, ruling }));
      return due ? withResearch(ruled, (research) => ({ ...research, revisionDue: research.drafts.length > 0 })) : ruled;
    }
    case "revision-started": {
      if (review.phase !== "complete" || !review.research) throw new ReviewError(`The answer is revised once the council has answered; it is ${review.phase}.`);
      if (!review.research.revisionDue) throw new ReviewError("Nothing to revise: no claim was struck or restored since the latest draft.");
      const editor = review.reviewers.find((reviewer) => reviewer.id === review.research!.editor && reviewer.enabled && reviewer.status === "completed")
        ?? seatedReviewers(review).find((reviewer) => reviewer.status === "completed");
      if (!editor) throw new ReviewError("No seat that completed the research is left to revise the answer.");
      return {
        ...updateReviewer(review, editor.id, (it) => ({ ...it, status: "deliberating", current: "Revising the answer" })),
        phase: "synthesis",
        verdict: null,
        endedAt: null,
        agentHeardAt: null,
        research: { ...review.research, revisionDue: false },
      };
    }
    case "agent-heard":
      return { ...review, agentHeardAt: event.at };
    case "agent-unheard":
      return { ...review, agentHeardAt: null };
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
      if (review.research) return arguedOnClaim(review, reviewer, event);
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
      // A fix reported again during the pass wasn't put to it (an older review's fixes have no pass recorded).
      if (finding.fix.recheckedIn !== undefined && finding.fix.recheckedIn !== review.verifications) throw new ReviewError(`${finding.id}'s fix isn't being re-checked in this pass.`);
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
    case "claim-reported": {
      if (review.phase !== "independent-review" || !review.research) throw new ReviewError(`Claims are reported in the research; the council is in ${review.phase}.`);
      const research = review.research;
      const claim: Claim = {
        ...event.claim,
        id: `C${research.claimsIssued + 1}`,
        reviewerId: reviewer.id,
        pass: research.pass,
        sources: event.claim.sources.map((source) => ({ ...source, checks: [] })),
        status: "reported",
        reportedAt: event.at,
        positions: [],
        resolution: null,
        alsoReported: [],
        ruling: null,
      };
      const reported = updateReviewer(review, reviewer.id, (it) => withActivity(it, { at: event.at, kind: "finding", text: `Reported ${claim.id} (${claim.kind}${claim.rq ? `, ${claim.rq}` : ""}): ${claim.title}` }));
      return { ...reported, research: { ...research, claims: [...research.claims, claim], claimsIssued: research.claimsIssued + 1 } };
    }
    case "source-checked": {
      if (review.phase !== "deliberation" || review.round !== 0 || !review.research) throw new ReviewError(`Sources are checked before the first round; the council is in ${review.phase}.`);
      const claim = claimOf(review, event.check.claimId);
      if (claim.pass !== review.research.pass) throw new ReviewError(`${claim.id} was checked in an earlier run.`);
      const index = event.check.source - 1;
      if (!claim.sources[index]) throw new ReviewError(`${claim.id} has no source ${event.check.source}; it has ${claim.sources.length}.`);
      const check = { reviewerId: reviewer.id, outcome: event.check.outcome, note: event.check.note, at: event.at };
      const checked = updateClaim(review, claim.id, (it) => ({
        ...it,
        // A seat's newer check of a source replaces its older one (a resumed check asks again).
        sources: it.sources.map((source, at) => (at === index ? { ...source, checks: [...source.checks.filter((each) => each.reviewerId !== reviewer.id), check] } : source)),
      }));
      return updateReviewer(checked, reviewer.id, (it) => withActivity(it, { at: event.at, kind: "check", text: `Checked ${claim.id}'s source ${event.check.source}: ${event.check.outcome}` }));
    }
    case "answer-drafted": {
      if (review.phase !== "synthesis" || !review.research) throw new ReviewError(`The answer is drafted in the synthesis; the council is in ${review.phase}.`);
      const research = review.research;
      const revision = research.drafts.filter((draft) => draft.pass === research.pass).length;
      const draft = { editorId: reviewer.id, pass: research.pass, revision, markdown: event.markdown, problems: event.problems, at: event.at };
      const drafted = updateReviewer(review, reviewer.id, (it) =>
        withActivity(it, { at: event.at, kind: "proposal", text: `${revision === 0 ? "Drafted" : "Revised"} the answer${event.problems.length > 0 ? ` (${event.problems.length} problem${event.problems.length === 1 ? "" : "s"})` : ""}` }),
      );
      return { ...drafted, research: { ...research, drafts: [...research.drafts, draft] } };
    }
    case "draft-objected": {
      if (review.phase !== "synthesis" || !review.research) throw new ReviewError(`A draft is checked in the synthesis; the council is in ${review.phase}.`);
      const research = review.research;
      const latest = research.drafts.at(-1);
      if (!latest || latest.pass !== research.pass) throw new ReviewError("There is no draft of this run to object to.");
      if (event.objection.claimId !== undefined) claimOf(review, event.objection.claimId);
      const objection = { id: `O${research.objections.length + 1}`, reviewerId: reviewer.id, pass: research.pass, revision: latest.revision, ...event.objection, at: event.at };
      const objected = updateReviewer(review, reviewer.id, (it) => withActivity(it, { at: event.at, kind: "argument", text: `Objected to the draft${objection.claimId ? ` on ${objection.claimId}` : ""}: ${objection.problem}` }));
      return { ...objected, research: { ...research, objections: [...research.objections, objection] } };
    }
    case "reviewer-finished": {
      const current = event.outcome === "completed" ? (review.research ? "Research complete" : "Review complete") : event.outcome === "failed" ? "Failed" : "Stopped";
      return updateReviewer(review, reviewer.id, (it) => ({ ...it, status: event.outcome, current, endedAt: event.at, problem: event.problem ?? null }));
    }
  }
}

/** Drops a reviewer's findings past the review's limit, and says so in its activity. */
function capped(review: Review, reviewerId: string, findingIds: string[], at: number): Review {
  const gone = new Set(findingIds);
  const text = `Kept its ${review.maxFindings} most severe finding${review.maxFindings === 1 ? "" : "s"}; dropped ${findingIds.join(", ")}`;
  const noted = updateReviewer(review, reviewerId, (it) => withActivity(it, { at, kind: "note", text }));
  return { ...noted, findings: review.findings.filter((finding) => !gone.has(finding.id)) };
}

/** Drops a researcher's claims past the limit, and says so in its activity. */
function cappedClaims(review: Review, reviewerId: string, claimIds: string[], at: number): Review {
  const gone = new Set(claimIds);
  const text = `Kept its ${review.maxFindings} best claim${review.maxFindings === 1 ? "" : "s"}; dropped ${claimIds.join(", ")}`;
  const noted = updateReviewer(review, reviewerId, (it) => withActivity(it, { at, kind: "note", text }));
  return withResearch(noted, (research) => ({ ...research, claims: research.claims.filter((claim) => !gone.has(claim.id)) }));
}

/** An argument on a claim of the current run, in a research council's round. */
function arguedOnClaim(review: Review, reviewer: Reviewer, event: Extract<ReviewerEvent, { type: "argued" }>): Review {
  const input = event.argument;
  const claim = claimOf(review, input.findingId);
  if (claim.pass !== review.research!.pass) throw new ReviewError(`${claim.id} was settled in an earlier run.`);
  if (input.replyTo !== undefined && !review.arguments.some(({ id }) => id === input.replyTo)) throw new ReviewError(`There is no argument ${input.replyTo}.`);
  const argument: Argument = {
    id: `A${review.arguments.length + 1}`,
    findingId: claim.id,
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
    updateClaim(review, claim.id, (it) => ({ ...it, positions: [...it.positions.filter(({ reviewerId }) => reviewerId !== reviewer.id), position] })),
    reviewer.id,
    (it) => withActivity(it, { at: event.at, kind: "argument", text: `${STANCE_VERBS[input.stance]} ${claim.id}: ${claim.title}` }),
  );
  return { ...argued, arguments: [...review.arguments, argument] };
}

/** A failed seat's late reply, taken in (`reply-fetched`). */
function takeLateReply(review: Review, event: ReplyFetched): Review {
  if (review.research) throw new ReviewError("A research seat's late reply can't be taken in; send the council back with a follow-up instead.");
  const reviewer = review.reviewers.find(({ id }) => id === event.reviewerId);
  if (!reviewer || !reviewer.enabled) throw new ReviewError(`No reviewer ${event.reviewerId} takes part in the review.`);
  if (reviewer.status !== "failed") throw new ReviewError(`${reviewer.label} hasn't failed; only a failed reviewer's reply is fetched.`);
  if (review.phase !== "independent-review" && review.phase !== "complete") {
    throw new ReviewError(isRunning(review) ? `The council is at work; fetch ${reviewer.label}'s reply once the review is complete.` : `A reply is fetched while the reviewers review or once the review is complete; it is ${review.phase}.`);
  }
  const { at } = event;
  const late = review.phase === "complete";
  const added: Finding[] = event.findings.map((input, index) => ({
    ...input,
    id: `F${review.findingsIssued + index + 1}`,
    reviewerId: reviewer.id,
    status: "reported",
    reportedAt: at,
    positions: [],
    resolution: null,
    proposal: null,
    ruling: null,
    fix: null,
    alsoReported: [],
    ...(late ? { late: true as const } : {}),
  }));
  let seat = withActivity(reviewer, { at, kind: "status", text: `Took its late reply from conversation ${event.conversationId}` });
  if (event.note) seat = withActivity(seat, { at, kind: "note", text: event.note });
  for (const finding of added) seat = withActivity(seat, { at, kind: "finding", text: `Reported ${finding.id}: ${finding.title}`, ...(finding.evidence[0] ? { path: finding.evidence[0].path } : {}) });
  for (const problem of event.rejected) seat = withActivity(seat, { at, kind: "error", text: `Rejected a malformed finding: ${problem}` });
  seat = withActivity(seat, { at, kind: "status", text: `Reported ${added.length} finding${added.length === 1 ? "" : "s"}` });
  seat = { ...seat, status: "completed", current: "Review complete", problem: null, endedAt: at };
  // During the independent review, any findings it had give way to the reply's, as a retry's do.
  const kept = late ? review.findings : review.findings.filter((finding) => finding.reviewerId !== reviewer.id);
  let next: Review = {
    ...review,
    reviewers: review.reviewers.map((each) => (each.id === reviewer.id ? seat : each)),
    findings: [...kept, ...added],
    findingsIssued: review.findingsIssued + added.length,
  };
  const dropped = overLimit(next, reviewer.id);
  if (dropped.length > 0) next = capped(next, reviewer.id, dropped, at);
  if (!late) return next;
  // After the verdict: the verdict is written again to count them, and the agent hears of the review anew.
  return { ...next, verdict: { summary: verdictSummary(next), at }, agentHeardAt: null };
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
  const research = review.research;
  if (phase === "independent-review") {
    const redo = new Set(review.reviewers.filter(cutShort).map(({ id }) => id));
    return {
      ...base,
      ...(research ? { research: { ...research, claims: research.claims.filter((claim) => !(claim.pass === research.pass && redo.has(claim.reviewerId))) } } : {}),
      phase,
      findings: review.findings.filter((finding) => !redo.has(finding.reviewerId)),
      reviewers: review.reviewers.map((reviewer) =>
        redo.has(reviewer.id) ? { ...withActivity(reviewer, { at, kind: "status", text: "Resuming after a restart" }), status: "waiting", current: "Waiting to resume", startedAt: null, endedAt: null } : reviewer,
      ),
    };
  }
  const back = review.reviewers.map((reviewer) => (cutShort(reviewer) ? { ...reviewer, status: "deliberating" as const, current: "Resuming after a restart", endedAt: null } : reviewer));
  if (phase === "deliberation") {
    // The cut-short round starts again; the engine starts it anew from the round before. An earlier run's arguments stay.
    const current = new Set(research ? currentClaims(review).map(({ id }) => id) : []);
    const args = review.arguments.filter((argument) => argument.round < review.round || (research !== undefined && !current.has(argument.findingId)));
    const resumed: Review = {
      ...base,
      phase,
      round: Math.max(0, review.round - 1),
      reviewers: back,
      arguments: args,
      findings: review.findings.map((finding) => ({ ...finding, positions: positionsFrom(review, finding, args, at) })),
    };
    return claimsPositioned(resumed, args.filter((argument) => current.has(argument.findingId)), at);
  }
  // The synthesis starts again after the last round.
  return {
    ...base,
    phase: "deliberation",
    round: review.rounds,
    reviewers: back,
    findings: review.findings.map((finding) => ({ ...finding, status: "reported", resolution: null, proposal: null })),
    // A research council settles its run's claims and drafts its answer again.
    ...(research
      ? {
          research: {
            ...research,
            claims: research.claims.map((claim) => (claim.pass === research.pass ? { ...claim, status: "reported" as const, resolution: null } : claim)),
            drafts: research.drafts.filter((draft) => draft.pass !== research.pass),
            objections: research.objections.filter((objection) => objection.pass !== research.pass),
          },
        }
      : {}),
  };
}

/** Applies one event; the review it gives back has the next sequence number unless the event changed nothing. */
export function reduce(review: Review, event: ReviewEvent): Review {
  const next = applyEvent(review, event);
  return next === review ? review : { ...next, seq: review.seq + 1 };
}
