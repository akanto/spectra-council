/**
 * The council's deliberation protocol: how many rounds a review gets, and how the synthesis settles each finding from
 * where the reviewers ended up standing. Pure: the engine runs the rounds and dispatches what this decides.
 */
import { argumentsOn, type Finding, type FindingStatus, type Review, type Reviewer, reportersOf } from "./model.ts";

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

  // Withdrawn once no one who reported it backs it any more (the reporter and any whose report merged into it); a
  // reporter the user removed has no say, and a finding whose reporters were all removed stands on the others' stances.
  const reporters = reportersOf(finding).filter((id) => byId(id)?.enabled);
  const reporterName = byId(reporters[0] ?? finding.reviewerId)?.label ?? finding.reviewerId;
  if (reporters.length > 0 && reporters.every((id) => stanceOf(id) !== undefined && stanceOf(id) !== "supports")) {
    const challengers = finding.positions.filter((position) => !reporters.includes(position.reviewerId) && position.stance === "challenges").map((position) => byId(position.reviewerId)).filter((it) => it !== undefined);
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

/**
 * Who re-checks a finding's fix: its reporter and the reviewers whose last stance backed it, among those who completed
 * the review. A disputed finding's dissenters are left out: the fix is checked against the finding as the council
 * accepted it.
 */
export function checkersOf(review: Review, finding: Finding): Reviewer[] {
  const backers = new Set(finding.positions.filter((position) => position.stance === "supports").map((position) => position.reviewerId));
  backers.add(finding.reviewerId);
  return review.reviewers.filter((reviewer) => reviewer.enabled && reviewer.status === "completed" && backers.has(reviewer.id));
}

/** The verdict in a sentence or two, from the settled findings. */
export function verdictSummary(review: Review): string {
  const { findings } = review;
  if (findings.length === 0) return "The council found nothing to report.";
  const count = (status: FindingStatus) => findings.filter((finding) => finding.status === status).length;
  const isSerious = (finding: Finding) => finding.severity === "critical" || finding.severity === "high";
  const serious = findings.filter((finding) => (finding.status === "confirmed" || finding.status === "agreed") && isSerious(finding)).length;
  const contested = findings.filter((finding) => finding.status === "disputed" && isSerious(finding)).length;
  const failed = review.reviewers.filter((reviewer) => reviewer.enabled && reviewer.status === "failed").map((reviewer) => reviewer.label);
  const dropped = failed.length > 0 ? ` ${failed.join(", ")} failed and took no part.` : "";
  if (count("reported") === findings.length) {
    return `${findings.length} finding${findings.length === 1 ? "" : "s"}, not deliberated: fewer than two reviewers finished their review.${dropped}`;
  }
  const parts = (["agreed", "confirmed", "disputed", "withdrawn"] as const).filter((status) => count(status) > 0).map((status) => `${count(status)} ${status}`);
  const head = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  const held = serious > 0 ? ` ${serious} serious finding${serious === 1 ? " stands" : "s stand"}.` : contested > 0 ? " No serious finding is agreed or confirmed." : " No serious finding stands.";
  // Kept as it was at the verdict (the hand-off quotes it), so it states the outcome rather than what is left to do.
  const open = contested > 0 ? ` ${contested} serious finding${contested === 1 ? " is" : "s are"} disputed.` : "";
  return head + held + open + dropped;
}
