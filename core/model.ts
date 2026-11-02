/**
 * A review's state: what the workspace shows and what a host persists. It changes only through the events of review.ts,
 * so any host (Mirador's canvas, a standalone app) can store, replay and draw it the same way.
 */
import type { Confidence, Depth, Evidence, ProfileId, Severity, Stance } from "./schemas.ts";

export type { Stance };

export const REVIEW_FORMAT = 2;

/**
 * Where a review is: set up, reviewed independently, deliberated in rounds, synthesised into a verdict, and ended.
 */
export type Phase = "setup" | "independent-review" | "deliberation" | "synthesis" | "complete" | "stopped" | "interrupted";

/** "deliberating": the reviewer finished its own review and takes part in the council's rounds. */
export type ReviewerStatus = "idle" | "waiting" | "reviewing" | "deliberating" | "completed" | "failed" | "stopped";

/**
 * What a reviewer was seen doing: events its runner reports, never its private reasoning. `path` is relative to the
 * review's target.
 */
export type ActivityKind = "status" | "read" | "search" | "tool" | "note" | "finding" | "argument" | "error";

export interface Activity {
  seq: number;
  at: number;
  kind: ActivityKind;
  text: string;
  path?: string;
}

export interface Reviewer {
  /** The seat's id, "r1" to "r4". */
  id: string;
  /** The agent's id in the registry. */
  agent: string;
  label: string;
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
}

/** The council's verdict, once the synthesis has settled every finding. */
export interface Verdict {
  summary: string;
  at: number;
}

/** Who runs the reviewers: deterministic mocks, or agents in Mirador's conversations (milestone 2). */
export type RunnerKind = "mock" | "mirador";

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
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The sequence number of the last event applied. */
  seq: number;
  /** When the host's agent last heard how the review ended; null until it has. */
  agentHeardAt: number | null;
}

export const MAX_ACTIVITY = 150;

/** Reviewers still at work: reviewing on their own, or taking part in the deliberation. */
export const isActive = (reviewer: Reviewer) =>
  reviewer.enabled && (reviewer.status === "waiting" || reviewer.status === "reviewing" || reviewer.status === "deliberating");

export const argumentsOn = (review: Review, findingId: string) => review.arguments.filter((argument) => argument.findingId === findingId);

export const isRunning = (review: Review) => review.phase === "independent-review" || review.phase === "deliberation" || review.phase === "synthesis";

export const isFinished = (review: Review) => review.phase === "complete" || review.phase === "stopped" || review.phase === "interrupted";

export const seatedReviewers = (review: Review) => review.reviewers.filter((reviewer) => reviewer.enabled);
