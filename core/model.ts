/**
 * A review's state: what the workspace shows and what a host persists. It changes only through the events of review.ts,
 * so any host (Mirador's canvas, a standalone app) can store, replay and draw it the same way.
 */
import type { Confidence, Depth, Evidence, ProfileId, Severity } from "./schemas.ts";

export const REVIEW_FORMAT = 1;

/**
 * Where a review is. Milestone 1 uses setup, independent-review and the ends; deliberation and synthesis come with the
 * council's rounds.
 */
export type Phase = "setup" | "independent-review" | "deliberation" | "synthesis" | "complete" | "stopped" | "interrupted";

export type ReviewerStatus = "idle" | "waiting" | "reviewing" | "completed" | "failed" | "stopped";

/**
 * What a reviewer was seen doing: events its runner reports, never its private reasoning. `path` is relative to the
 * review's target.
 */
export type ActivityKind = "status" | "read" | "search" | "tool" | "note" | "finding" | "error";

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

/** What the council made of a finding. Milestone 1 only reports; deliberation decides the rest. */
export type FindingStatus = "reported" | "confirmed" | "disputed" | "agreed" | "withdrawn";

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
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The sequence number of the last event applied. */
  seq: number;
  /** When the host's agent last heard how the review ended; null until it has. */
  agentHeardAt: number | null;
}

export const MAX_ACTIVITY = 150;

export const isRunning = (review: Review) => review.phase === "independent-review" || review.phase === "deliberation" || review.phase === "synthesis";

export const isFinished = (review: Review) => review.phase === "complete" || review.phase === "stopped" || review.phase === "interrupted";

export const seatedReviewers = (review: Review) => review.reviewers.filter((reviewer) => reviewer.enabled);
