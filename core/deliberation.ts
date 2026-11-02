/**
 * The council's deliberation protocol: how many rounds a review gets, and how the synthesis settles each finding from
 * where the reviewers ended up standing. Pure: the engine runs the rounds and dispatches what this decides.
 */
import { argumentsOn, type Finding, type FindingStatus, type Review, type Reviewer } from "./model.ts";
import type { Depth } from "./schemas.ts";

/** Rounds per depth: a challenge needs one round to be made, one to be answered and one to be reconsidered. */
export const ROUNDS: Record<Depth, number> = { quick: 2, standard: 3, deep: 4 };

export interface Settlement {
  status: Exclude<FindingStatus, "reported">;
  rationale: string;
  dissenters: string[];
}

const names = (reviewers: Reviewer[]) => {
  const labels = reviewers.map((reviewer) => reviewer.label);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
};

/**
 * Settles one finding from each reviewer's last stance on it:
 * - withdrawn: its reporter no longer backs it;
 * - disputed: someone's challenge still stands, however many back it (the dissent is kept, not outvoted);
 * - agreed: nobody ever challenged it, and everyone who took part backs it;
 * - confirmed: otherwise; it was challenged and the challenge was answered, or some couldn't tell but nobody objects.
 */
export function settle(review: Review, finding: Finding): Settlement {
  const byId = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id);
  const reporter = byId(finding.reviewerId);
  const stanceOf = (id: string) => finding.positions.find((position) => position.reviewerId === id)?.stance;
  const reporterName = reporter?.label ?? finding.reviewerId;

  if (stanceOf(finding.reviewerId) !== undefined && stanceOf(finding.reviewerId) !== "supports") {
    const challengers = finding.positions.filter((position) => position.reviewerId !== finding.reviewerId && position.stance === "challenges").map((position) => byId(position.reviewerId)).filter((it) => it !== undefined);
    return {
      status: "withdrawn",
      rationale: challengers.length > 0 ? `${reporterName} withdrew it after ${names(challengers)}'s challenge.` : `${reporterName} withdrew it.`,
      dissenters: [],
    };
  }

  const participants = review.reviewers.filter((reviewer) => reviewer.enabled && (reviewer.status === "deliberating" || reviewer.status === "completed"));
  const backers = participants.filter((reviewer) => stanceOf(reviewer.id) === "supports");
  const dissenters = participants.filter((reviewer) => stanceOf(reviewer.id) === "challenges");
  const unsure = participants.filter((reviewer) => stanceOf(reviewer.id) === "uncertain");
  const tally = `${backers.length} of ${participants.length} back it`;

  if (dissenters.length > 0) {
    const plural = dissenters.length === 1 ? "challenge stands" : "challenges stand";
    return { status: "disputed", rationale: `${tally}; ${names(dissenters)}'s ${plural}.`, dissenters: dissenters.map((reviewer) => reviewer.id) };
  }
  const everChallenged = argumentsOn(review, finding.id).some((argument) => argument.stance === "challenges" && argument.reviewerId !== finding.reviewerId);
  if (!everChallenged && unsure.length === 0 && backers.length === participants.length && participants.length > 1) {
    return { status: "agreed", rationale: `All ${participants.length} reviewers back it.`, dissenters: [] };
  }
  const answered = everChallenged ? "; the challenge was answered" : "";
  const doubt = unsure.length > 0 ? `; ${names(unsure)} couldn't tell` : "";
  return { status: "confirmed", rationale: `${tally}${answered}${doubt}.`, dissenters: [] };
}

/** The verdict in a sentence or two, from the settled findings. */
export function verdictSummary(review: Review): string {
  const { findings } = review;
  if (findings.length === 0) return "The council found nothing to report.";
  const count = (status: FindingStatus) => findings.filter((finding) => finding.status === status).length;
  const serious = findings.filter((finding) => (finding.status === "confirmed" || finding.status === "agreed") && (finding.severity === "critical" || finding.severity === "high")).length;
  if (count("reported") === findings.length) {
    return `${findings.length} finding${findings.length === 1 ? "" : "s"}, not deliberated: fewer than two reviewers finished their review.`;
  }
  const parts = (["agreed", "confirmed", "disputed", "withdrawn"] as const).filter((status) => count(status) > 0).map((status) => `${count(status)} ${status}`);
  const head = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  const tail = serious > 0 ? ` ${serious} serious finding${serious === 1 ? " stands" : "s stand"}.` : " No serious finding stands.";
  return head + tail;
}
