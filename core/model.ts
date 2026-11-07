/**
 * A review's state: what the workspace shows and what a host persists. It changes only through the events of review.ts,
 * so any host (Mirador's canvas, a standalone app) can store, replay and draw it the same way.
 */
import type { Confidence, Decision, Depth, Evidence, ProfileId, Severity, Stance } from "./schemas.ts";

export type { Decision, Stance };

export const REVIEW_FORMAT = 6;

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

/** How the synthesis settled a finding: its status in words, with any dissent named. */
export interface Resolution {
  status: Exclude<FindingStatus, "reported">;
  /** Why, in a sentence, e.g. "3 of 4 back it; Qwen's challenge stands: …". */
  rationale: string;
  /** The reviewers whose challenge still stands, for a disputed finding. */
  dissenters: string[];
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
}

/** The hand-off document: the accepted findings, how the council got there and the proposed fixes, written to a file. */
export interface Handoff {
  /** Absolute path of the Markdown file. */
  path: string;
  findingIds: string[];
  at: number;
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
  /** Why the fixer didn't fix it, when it said so or ended without saying; cleared by a fix report or a new hand-off. */
  problem: string | null;
  /** What the agent said it changed, the latest report. */
  summary: string | null;
  files: string[];
  fixedAt: number | null;
  checks: FixCheck[];
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
  depth: Depth;
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
