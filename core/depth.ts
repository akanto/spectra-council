/**
 * How much a review does, in numbers the user can see: the deliberation's rounds and the most findings each reviewer
 * may report. The depth presets (Quick, Standard, Deep) fill both in; any other pair is "custom". Pure.
 */
import { CONFIDENCES, SEVERITIES, type Depth } from "./schemas.ts";
import type { Finding, Review } from "./model.ts";

/** A review's depth as the setup shows it: one of the presets, or "custom" once a knob was set off them. */
export type DepthChoice = Depth | "custom";

export interface Knobs {
  /** Deliberation rounds, ROUNDS_RANGE. */
  deliberationRounds: number;
  /** The most findings one reviewer reports, MAX_FINDINGS_RANGE. */
  maxFindings: number;
}

export const ROUNDS_RANGE = { min: 1, max: 6 } as const;
export const MAX_FINDINGS_RANGE = { min: 1, max: 20 } as const;

/** What each preset sets: a challenge needs a round to be made, one to be answered and one to be reconsidered. */
export const DEPTH_PRESETS: Record<Depth, Knobs> = {
  quick: { deliberationRounds: 2, maxFindings: 3 },
  standard: { deliberationRounds: 3, maxFindings: 6 },
  deep: { deliberationRounds: 4, maxFindings: 10 },
};

export const DEPTH_TITLES: Record<DepthChoice, string> = { quick: "Quick", standard: "Standard", deep: "Deep", custom: "Custom" };

/** The preset these knobs match, or "custom". */
export function depthOf(knobs: Knobs): DepthChoice {
  const match = (Object.keys(DEPTH_PRESETS) as Depth[]).find(
    (depth) => DEPTH_PRESETS[depth].deliberationRounds === knobs.deliberationRounds && DEPTH_PRESETS[depth].maxFindings === knobs.maxFindings,
  );
  return match ?? "custom";
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The knobs in words: "3 rounds, at most 6 findings per reviewer". */
export const knobsText = (knobs: Knobs) => `${plural(knobs.deliberationRounds, "round")}, at most ${plural(knobs.maxFindings, "finding")} per reviewer`;

/**
 * The most agent turns a review with these seats and knobs runs, by the engine's phases: each reviewer's own review;
 * with two seats or more, the grouping turn (only when a real agent sits, `realAgents`), each reviewer's turn in every
 * round, and one fix-proposal turn per reviewer (a reviewer with no finding that stands has none). Retries, the repair
 * of an unreadable reply, and fix re-checks aren't counted.
 */
export function plannedTurns(seats: number, knobs: Knobs, realAgents: boolean): { total: number; review: number; grouping: number; rounds: number; proposals: number } {
  const review = seats;
  if (seats < 2) return { total: review, review, grouping: 0, rounds: 0, proposals: 0 };
  const grouping = realAgents ? 1 : 0;
  const rounds = seats * knobs.deliberationRounds;
  const proposals = seats;
  return { total: review + grouping + rounds + proposals, review, grouping, rounds, proposals };
}

const rank = (finding: Finding) => SEVERITIES.indexOf(finding.severity) * CONFIDENCES.length + CONFIDENCES.indexOf(finding.confidence);

/**
 * The findings a reviewer reported past its limit, to drop: it keeps its `maxFindings` most severe (more confident
 * first among equals, then the earliest reported). Empty when it is within the limit.
 */
export function overLimit(review: Review, reviewerId: string): string[] {
  const own = review.findings.filter((finding) => finding.reviewerId === reviewerId);
  if (own.length <= review.maxFindings) return [];
  const kept = new Set([...own].sort((a, b) => rank(a) - rank(b) || own.indexOf(a) - own.indexOf(b)).slice(0, review.maxFindings));
  return own.filter((finding) => !kept.has(finding)).map(({ id }) => id);
}
