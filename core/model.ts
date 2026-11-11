/**
 * A review's state: what the workspace shows and what a host persists. It changes only through the events of review.ts,
 * so any host (Mirador's canvas, a standalone app) can store, replay and draw it the same way.
 */
import type { DepthChoice } from "./depth.ts";
import type { Confidence, Decision, Evidence, ProfileId, Severity, Stance } from "./schemas.ts";

export type { Decision, Stance };

export const REVIEW_FORMAT = 8;

/**
 * Where a review is: set up, reviewed independently, deliberated in rounds, synthesised into a verdict, and ended. After
 * the verdict the user rules on the findings and hands them off; once fixes come in, a verification round re-checks them
 * and the review is complete again.
 */
export type Phase = "setup" | "independent-review" | "deliberation" | "synthesis" | "complete" | "verification" | "stopped" | "interrupted";

/**
 * "deliberating": the reviewer finished its own review and takes part in the council's rounds and synthesis.
 * "verifying": it re-checks fixes in a verification round, then is "completed" again.
 */
export type ReviewerStatus = "idle" | "waiting" | "reviewing" | "deliberating" | "verifying" | "completed" | "failed" | "stopped";

/**
 * What a reviewer was seen doing: events its runner reports, never its private reasoning. `path` is relative to the
 * review's target.
 */
export type ActivityKind = "status" | "read" | "search" | "tool" | "note" | "finding" | "argument" | "proposal" | "check" | "error";

export interface Activity {
  seq: number;
  at: number;
  kind: ActivityKind;
  text: string;
  path?: string;
}

/**
 * The model a real reviewer runs on, as Mirador names it in the conversation's header: "Opus 5.5" with effort "high",
 * say. Before the review starts it is what the profile's latest conversation ran on; once a turn starts, what that
 * turn's conversation runs on.
 */
export interface ModelInfo {
  /** The model's name and version, without a provider prefix: "Opus 5.5", "Qwen 3.8 Max". */
  name: string;
  /** The effort or thinking level, lower case ("high", "medium"); null when the model has none or it's unknown. */
  effort: string | null;
}

export interface Reviewer {
  /** The seat's id, "r1", "r2", … in seat order. */
  id: string;
  /** The agent's id in the registry. */
  agent: string;
  /**
   * The name the review shows for it: a profile seat's model when known ("Opus 5.5"), else the profile's or mock's
   * name; made unique across the council ("Opus 5.5 (Home)", "Claude 2") by `withLabels` (core/agents.ts).
   */
  label: string;
  /** The model a profile seat runs on, once the host could tell; null for a mock. */
  model: ModelInfo | null;
  /** False for a seat that takes no part: one the user removed after it failed, or an unseated seat of an older review. */
  enabled: boolean;
  status: ReviewerStatus;
  /** What it is doing now, in a few words. */
  current: string | null;
  /** Its latest activity, oldest first, the newest MAX_ACTIVITY kept. */
  activity: Activity[];
  /** How many activities it had in all, kept or not. */
  activityCount: number;
  startedAt: number | null;
  endedAt: number | null;
  problem: string | null;
}

/**
 * What the council made of a finding. "reported" until the synthesis decides: "agreed" when every reviewer who weighed
 * in backed it and nobody ever challenged it; "confirmed" when it holds up, backed by most and with no challenge left
 * standing; "disputed" when a challenge still stands at the end (the minority report, kept on the record); "withdrawn"
 * when its reporter conceded.
 */
export type FindingStatus = "reported" | "confirmed" | "disputed" | "agreed" | "withdrawn";

/** One reviewer's latest stance on a finding. The reporter starts out supporting its own. */
export interface Position {
  reviewerId: string;
  stance: Stance;
  confidence: Confidence;
  /** The round it was taken in; 0 for the reporter's own at the start of the deliberation. */
  round: number;
  at: number;
}

/** One entry in a finding's deliberation timeline: what a reviewer argued, in which round, with what evidence. */
export interface Argument {
  /** "A1", "A2", … across the review, in the order they came in. */
  id: string;
  findingId: string;
  reviewerId: string;
  round: number;
  stance: Stance;
  confidence: Confidence;
  text: string;
  evidence: Evidence[];
  /** The argument this one answers, if any. */
  replyTo?: string;
  at: number;
}

/** A challenge that still stands at the synthesis: who holds it, and why in a sentence, cut from their latest challenge. */
export interface Dissent {
  reviewerId: string;
  /** One sentence (at most DISSENT_REASON_MAX characters) from the argument; empty if it said nothing. */
  reason: string;
  /** The challenge it was cut from, where the full argument is. */
  argumentId: string;
}

/** How the synthesis settled a finding: its status in words, with any dissent named. */
export interface Resolution {
  status: Exclude<FindingStatus, "reported">;
  /** Why, in a sentence, e.g. "3 of 4 back it; Qwen's challenge stands." (the dissent's reasons are in `dissent`). */
  rationale: string;
  /** The reviewers whose challenge still stands, for a disputed finding. */
  dissenters: string[];
  /** Why each dissenter still challenges it, for a disputed finding; absent in reviews settled before it was kept. */
  dissent?: Dissent[];
  at: number;
}

/**
 * Another reviewer's report of the same problem, merged into this finding after the independent review: its own id,
 * title and evidence, kept for the record.
 */
export interface CoReport {
  reviewerId: string;
  /** The id it was reported under, which no longer names a finding of its own. */
  findingId: string;
  title: string;
  severity: Severity;
  evidence: Evidence[];
  /** The reviewer whose grouping turn merged it, when an agent judged it the same problem; absent for a rule's merge. */
  mergedBy?: string;
  /** Why that reviewer judged it the same problem. */
  reason?: string;
}

export interface Finding {
  /** "F1", "F2", … in the order they came in. */
  id: string;
  reviewerId: string;
  title: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  evidence: Evidence[];
  recommendation?: string;
  status: FindingStatus;
  reportedAt: number;
  /** Each reviewer's latest stance on it, one per reviewer who took one. */
  positions: Position[];
  /** Set by the synthesis. */
  resolution: Resolution | null;
  /** Drafted in the synthesis for a finding that stands. */
  proposal: FixProposal | null;
  /** The user's decision, after the verdict. */
  ruling: Ruling | null;
  /** Reports of the same problem by others (or the same reviewer), merged into this one; they back it from the start. */
  alsoReported: CoReport[];
  /** Set once an accepted finding is handed off. */
  fix: Fix | null;
  /** The beads issue filed for it, once asked for; absent in reviews from before tickets. */
  ticket?: Ticket | null;
  /**
   * Taken in after the verdict, from a reviewer's late reply (`reply-fetched` on a complete review that doesn't reopen):
   * the council never weighed it, so it stays reported and is ruled on as reported. Absent otherwise.
   */
  late?: true;
}

/** A beads issue for an accepted finding: asked of the agent, then filed under the id it reports. */
export interface Ticket {
  /** The issue's id, e.g. "spectra-council-x1y"; null until the agent reports it. */
  id: string | null;
  requestedAt: number;
  filedAt: number | null;
}

/** What the user asked the agent to do about the accepted findings, in their own words. */
export interface Ask {
  text: string;
  findingIds: string[];
  at: number;
  /** Sent to the fixer profile in a conversation of its own, rather than this conversation's agent; absent if not. */
  fixer?: AskFixer;
}

/** An ask sent to the fixer profile: its conversation, once started, and how it ended. */
export interface AskFixer {
  profile: string;
  /** Null until the conversation's agent starts it (council_delegate_fix). */
  conversationId: string | null;
  /** When the fixer's conversation ended its turn; null while it waits or works. */
  endedAt: number | null;
  /** Why its reply couldn't be used (it failed, was stopped, or had no JSON report); null otherwise. */
  problem: string | null;
}

/** The hand-off document: the accepted findings, how the council got there and the proposed fixes, written to a file. */
export interface Handoff {
  /** Absolute path of the Markdown file. */
  path: string;
  findingIds: string[];
  at: number;
  /** A digest of the Markdown written, to tell whether the file is stale; missing in reviews stored before it. */
  digest?: string;
}

/** What the user decided to do about a finding after the verdict: accepted, dismissed or deferred. */
export interface Ruling {
  decision: Decision;
  /** Why, in the user's words; may be empty. For a disputed finding, which side the user took. */
  note: string;
  at: number;
}

/**
 * The fix the council proposes for a finding that stands (agreed, confirmed or disputed), drafted in the synthesis by
 * its reporter, drawing on the deliberation: what to change, where, and how to tell it worked.
 */
export interface FixProposal {
  drafterId: string;
  /** The fix in a sentence. */
  summary: string;
  /** What to do, in order. */
  steps: string[];
  /** The files the fix touches, relative to the target. */
  files: string[];
  /** How to tell the fix worked: a test to add, a check to run. */
  verification: string;
  /** What could go wrong, and anything the dissent warned about. */
  risks?: string;
  at: number;
}

/**
 * Where the fix of an accepted finding is: handed off to the agent, reported fixed, and then verified or reopened by
 * the council's re-check (a reopened one can be fixed again).
 */
export type FixState = "handed-off" | "fixed" | "verified" | "reopened";

/** One reviewer's re-check of a fix in a verification round. */
export interface FixCheck {
  reviewerId: string;
  outcome: "verified" | "reopened";
  text: string;
  evidence: Evidence[];
  /** Which verification round, 1-based. */
  pass: number;
  at: number;
}

/**
 * Who fixes a handed-off finding: the agent of another Mirador profile, in a conversation the plugin starts for it
 * (null until it started). A fix without a fixer is the review's own conversation's agent.
 */
export interface Fixer {
  /** The profile's name, as Mirador has it. */
  profile: string;
  conversationId: string | null;
}

export interface Fix {
  state: FixState;
  handedOffAt: number;
  fixer: Fixer | null;
  /**
   * Why the fixer didn't fix it, when it said so or ended without saying; cleared by a fix report or a new hand-off. A
   * handed-off fix without one is someone's work in progress, which asking for fixes again leaves alone; with one, it
   * is handed to a new fixer. On a fixed fix: why the last re-check settled nothing about it (no check came back,
   * as when its checkers' turns failed); cleared when the next re-check starts.
   */
  problem: string | null;
  /** What the agent said it changed, the latest report. */
  summary: string | null;
  files: string[];
  fixedAt: number | null;
  checks: FixCheck[];
  /** The latest re-check pass this fix was put to (verification-started); absent before one. */
  recheckedIn?: number;
}

/** The council's verdict, once the synthesis has settled every finding. */
export interface Verdict {
  summary: string;
  at: number;
}

/**
 * Who runs the reviewers: deterministic mocks, agents in conversations on the user's Mirador profiles, or some of each.
 * It follows the seats while the review is set up.
 */
export type RunnerKind = "mock" | "mirador" | "mixed";

export interface Review {
  format: typeof REVIEW_FORMAT;
  id: string;
  target: string;
  profile: ProfileId;
  /** The preset the knobs match, or "custom". */
  depth: DepthChoice;
  /** How many rounds the deliberation will have (`rounds` below is set from it when the deliberation starts). */
  deliberationRounds: number;
  /** The most findings one reviewer may report; the engine drops the least severe past it. */
  maxFindings: number;
  instructions: string;
  runner: RunnerKind;
  phase: Phase;
  reviewers: Reviewer[];
  findings: Finding[];
  /** Every argument of the deliberation, oldest first; a finding's timeline is those with its id. */
  arguments: Argument[];
  /** The deliberation's current round, 1-based; 0 before it starts. */
  round: number;
  /** How many rounds the deliberation has; 0 until it starts. */
  rounds: number;
  verdict: Verdict | null;
  /** The latest hand-off written, if any. */
  handoff: Handoff | null;
  /** How many verification rounds have run. */
  verifications: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The sequence number of the last event applied. */
  seq: number;
  /** When the host's agent last heard how the review ended; null until it has. */
  agentHeardAt: number | null;
  /** How many finding ids were given out, F1 to F<n>: ids aren't reused after findings are dropped or merged. */
  findingsIssued: number;
  /** The phase a review was in when a restart cut it short, for resuming it there; null otherwise. */
  interruptedPhase: ResumablePhase | null;
  /**
   * Whether an agent has grouped the findings by meaning, in the grouping turn at the start of the deliberation; a
   * resumed review doesn't ask again.
   */
  duplicatesChecked: boolean;
  /** What the user asked the agent about the accepted findings, oldest first; absent in reviews from before asks. */
  asks?: Ask[];
}

/** The phases a review cut short by a restart can resume in. (A cut-short re-check just ends; it can be run again.) */
export type ResumablePhase = "independent-review" | "deliberation" | "synthesis";

/** Who reported a finding: its reporter first, then whoever's report of it was merged in. */
export const reportersOf = (finding: Finding): string[] => [...new Set([finding.reviewerId, ...finding.alsoReported.map((report) => report.reviewerId)])];

export const isResumable = (review: Review) => review.phase === "interrupted" && review.interruptedPhase !== null;

export const MAX_ACTIVITY = 150;

/** Reviewers still at work: reviewing on their own, or taking part in the deliberation. */
export const isActive = (reviewer: Reviewer) =>
  reviewer.enabled && (reviewer.status === "waiting" || reviewer.status === "reviewing" || reviewer.status === "deliberating" || reviewer.status === "verifying");

export const argumentsOn = (review: Review, findingId: string) => review.arguments.filter((argument) => argument.findingId === findingId);

export const isRunning = (review: Review) =>
  review.phase === "independent-review" || review.phase === "deliberation" || review.phase === "synthesis" || review.phase === "verification";

export const isFinished = (review: Review) => review.phase === "complete" || review.phase === "stopped" || review.phase === "interrupted";

export const seatedReviewers = (review: Review) => review.reviewers.filter((reviewer) => reviewer.enabled);

/** Findings that stand after the synthesis: the ones worth a fix proposal and a ruling. */
export const isStanding = (finding: Finding) => finding.status === "agreed" || finding.status === "confirmed" || finding.status === "disputed";

/**
 * Uncorroborated reports can be ruled on individually after a review without deliberation, as can a late finding taken
 * in after the verdict.
 */
export const isRulable = (review: Review, finding: Finding) => isStanding(finding) ||
  (finding.status === "reported" && (review.rounds === 0 || finding.late === true) && (review.phase === "complete" || review.phase === "verification"));
