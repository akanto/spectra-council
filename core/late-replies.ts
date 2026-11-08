/**
 * A profile seat's late reply: the reply its conversation gave after the seat gave up on it (its turn ran past the
 * limit, say). The seat's activity records which turn it ran last and in which conversation, in the words the agent
 * runner logs them; this reads them back, so a review stored before anything else recorded them can fetch one too.
 * Pure, for the view as well as the host.
 */
import { isProfileAgent } from "./agents.ts";
import type { Review, Reviewer } from "./model.ts";

/** What the agent runner logs as a turn starts: "Asking the alpha profile to review". */
export const askingText = (profile: string, what: string) => `Asking the ${profile} profile ${what}`;

/** What the agent runner logs once a turn's conversation started. */
export const startedText = (conversationId: string) => `Started conversation ${conversationId}`;

/** The `what` of a seat's own review turn, in `askingText`. */
export const REVIEW_TURN = "to review";

const ASKING = /^Asking the .+ profile (to .+)$/;
const STARTED = /^Started conversation (\S+)$/;

/**
 * The turn a seat ran last (its `what`, e.g. "to review" or "to argue round 2") and the latest conversation it started
 * for it (the repair's, when it was asked again); null when its activity names no turn. The conversation is null when
 * none had started.
 */
export function lastTurnOf(reviewer: Reviewer): { what: string; conversationId: string | null } | null {
  let conversationId: string | null = null;
  for (let at = reviewer.activity.length - 1; at >= 0; at--) {
    const { kind, text } = reviewer.activity[at]!;
    if (kind === "tool" && conversationId === null) conversationId = STARTED.exec(text)?.[1] ?? null;
    const asking = kind === "status" ? ASKING.exec(text) : null;
    if (asking) return { what: asking[1]!, conversationId };
  }
  return null;
}

/**
 * Why a seat's late reply can't be fetched now, or null when it can: a seated profile seat that failed its own review
 * (in the independent review, still running, or once the review is complete) and whose conversation is known.
 */
export function whyNoFetch(review: Review, reviewer: Reviewer): string | null {
  if (!reviewer.enabled || !isProfileAgent(reviewer.agent)) return `${reviewer.label} has no conversation of its own to fetch a reply from.`;
  if (reviewer.status !== "failed") return `${reviewer.label} hasn't failed; only a failed reviewer's reply is fetched.`;
  if (review.phase === "deliberation" || review.phase === "synthesis" || review.phase === "verification") return `The council is at work; fetch ${reviewer.label}'s reply once the review is complete.`;
  if (review.phase !== "independent-review" && review.phase !== "complete") return `A reply is fetched while the reviewers review or once the review is complete; it is ${review.phase}.`;
  const turn = lastTurnOf(reviewer);
  if (!turn || turn.what !== REVIEW_TURN) {
    return `${reviewer.label} failed ${turn ? `when asked ${turn.what}` : "outside its own review"}; only a reply to its own review can be fetched.`;
  }
  if (turn.conversationId === null) return `${reviewer.label}'s review never started a conversation, so there is no reply to fetch.`;
  return null;
}

/** Whether the view offers to fetch this seat's late reply. */
export const canFetchReply = (review: Review, reviewer: Reviewer) => whyNoFetch(review, reviewer) === null;
