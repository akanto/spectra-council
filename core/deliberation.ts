/**
 * The council's deliberation protocol: how many rounds a review gets, and how the synthesis settles each finding from
 * where the reviewers ended up standing. Pure: the engine runs the rounds and dispatches what this decides.
 */
import { argumentsOn, type Dissent, type Finding, type FindingStatus, type Review, type Reviewer, reportersOf } from "./model.ts";

export interface Settlement {
  status: Exclude<FindingStatus, "reported">;
  rationale: string;
  dissenters: string[];
  /** Why each dissenter still challenges it; only for a disputed finding. */
  dissent?: Dissent[];
}

/** The longest a dissent's reason runs, in characters; the full argument stays in the timeline. */
export const DISSENT_REASON_MAX = 200;

/** Words whose dot doesn't end a sentence. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "resp", "fig", "no"]);

/** Where the sentence starting at `from` ends (just past its closing punctuation and any quote), or -1. */
function sentenceEnd(text: string, from: number): number {
  const ends = /[.!?]["')\]]*(?=\s+["'(`*]?[A-Z0-9]|$)/g;
  ends.lastIndex = from;
  for (let match = ends.exec(text); match; match = ends.exec(text)) {
    const word = /(\S+)$/.exec(text.slice(from, match.index))?.[1]?.toLowerCase() ?? "";
    // "e.g. React", "U.S. law", "A. Smith": an abbreviation or a single letter, not the end of a sentence.
    if (match[0].startsWith(".") && (ABBREVIATIONS.has(word.replace(/^[("'`]+/, "")) || /^[a-z](\.[a-z])*$/.test(word))) continue;
    return match.index + match[0].length;
  }
  return -1;
}

/** Below this, a first sentence is a lead-in ("I disagree.") and the next one is taken too. */
const LEAD_IN = 40;

/**
 * The gist of an argument, for a dissent's reason: its first sentence (with the next ones while it is still a short
 * lead-in like "Not a bug."), at most `max` characters, cut at a word with "…" when longer. A sentence ends at ".", "!"
 * or "?" followed by a space and a capital (or the end), so "api.ts:42" and "e.g. React" don't end it.
 */
export function firstSentence(text: string, max = DISSENT_REASON_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let end = 0;
  while (end < flat.length && end < LEAD_IN) {
    const next = sentenceEnd(flat, end);
    if (next === -1) {
      end = flat.length;
      break;
    }
    end = next;
  }
  const sentence = flat.slice(0, end).trim();
  if (sentence.length <= max) return sentence;
  let cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  // A hard cut keeps no half of a surrogate pair, and no half of a token (which could turn "F12" into a link to F1).
  else cut = cut.replace(/[\ud800-\udbff]$/, "").replace(/[\w./-]{1,24}$/, "");
  return `${cut.replace(/[\s,;:.]+$/, "")}…`;
}

const names = (reviewers: Reviewer[]) => {
  const labels = reviewers.map((reviewer) => reviewer.label);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
};

const its = (reviewers: Reviewer[]) => (reviewers.length === 1 ? "its" : "their");

/**
 * Whether a reviewer's recorded stance on a finding counts in its synthesis: that of every seated reviewer still at the
 * council, and that of one that failed after recording a stance on it (its report, or an argument), which stands as it
 * left it: a timeout neither takes back a reporter's support nor answers a challenge. A removed reviewer has no say, and
 * one that failed with no stance on the finding left nothing of its own to keep.
 */
export function countsIn(reviewer: Reviewer, finding: Finding): boolean {
  if (!reviewer.enabled) return false;
  if (reviewer.status === "deliberating" || reviewer.status === "completed") return true;
  return reviewer.status === "failed" && finding.positions.some((position) => position.reviewerId === reviewer.id);
}

/**
 * Settles one finding from the last stance of each reviewer who counts (`countsIn`), or gives null when nothing settles
 * it and it stays reported:
 * - withdrawn: its reporter no longer backs it;
 * - disputed: someone's challenge still stands, however many back it (the dissent is kept, not outvoted);
 * - agreed: nobody ever challenged it, and everyone who counts backs it;
 * - confirmed: otherwise, when someone backs it: each challenge was answered (its challenger came round to back it), or
 *   some couldn't tell but nobody objects;
 * - null: nobody backs it (its reporters were removed, and no one else backs it).
 * A reviewer that failed during the deliberation keeps its last stance, and the rationale says it couldn't continue: a
 * timeout neither answers a challenge nor takes back support.
 */
export function settle(review: Review, finding: Finding): Settlement | null {
  const byId = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id);
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

  const participants = review.reviewers.filter((reviewer) => countsIn(reviewer, finding));
  const backers = participants.filter((reviewer) => stanceOf(reviewer.id) === "supports");
  const dissenters = participants.filter((reviewer) => stanceOf(reviewer.id) === "challenges");
  const unsure = participants.filter((reviewer) => stanceOf(reviewer.id) === "uncertain");
  // Whose stance here was kept from before they failed: the deliberation went on without them, and the rationale says so.
  const leftEarly = participants.filter((reviewer) => reviewer.status === "failed" && stanceOf(reviewer.id) !== undefined);
  const early = leftEarly.length > 0 ? `; ${names(leftEarly)} couldn't continue, so ${its(leftEarly)} last stance${leftEarly.length === 1 ? " counts" : "s count"}` : "";
  const tally = `${backers.length} of ${participants.length} back it`;
  const timeline = argumentsOn(review, finding.id);

  if (dissenters.length > 0) {
    const dissent = dissenters.flatMap((reviewer): Dissent[] => {
      const latest = timeline.filter((argument) => argument.reviewerId === reviewer.id && argument.stance === "challenges").at(-1);
      return latest ? [{ reviewerId: reviewer.id, reason: firstSentence(latest.text), argumentId: latest.id }] : [];
    });
    const plural = dissenters.length === 1 ? "challenge stands" : "challenges stand";
    return { status: "disputed", rationale: `${tally}; ${names(dissenters)}'s ${plural}${early}.`, dissenters: dissenters.map((reviewer) => reviewer.id), dissent };
  }
  // Only positive support makes a finding stand: silence, doubt and departures confirm nothing.
  if (backers.length === 0) return null;

  // A challenge is answered only when its challenger came round to back it. One who came round only as far as "couldn't
  // tell" is named among the unsure, and a removed reviewer's challenge no longer counts; neither is an answer.
  const reporterIds = reportersOf(finding);
  const challengerIds = [...new Set(timeline.filter((argument) => argument.stance === "challenges" && !reporterIds.includes(argument.reviewerId)).map((argument) => argument.reviewerId))];
  if (challengerIds.length === 0 && unsure.length === 0 && backers.length === participants.length && participants.length > 1) {
    return { status: "agreed", rationale: `All ${participants.length} reviewers back it${early}.`, dissenters: [] };
  }
  const answeredBy = backers.filter((reviewer) => challengerIds.includes(reviewer.id));
  const answered =
    answeredBy.length === 0
      ? ""
      : answeredBy.length === challengerIds.length
        ? `; the challenge${answeredBy.length === 1 ? " was" : "s were"} answered`
        : `; ${names(answeredBy)}'s challenge${answeredBy.length === 1 ? " was" : "s were"} answered`;
  const doubt = unsure.length > 0 ? `; ${names(unsure)} couldn't tell` : "";
  const setAside = challengerIds.flatMap((id) => {
    const reviewer = byId(id);
    return reviewer && !reviewer.enabled ? [reviewer] : [];
  });
  const removed = setAside.length > 0 ? `; ${names(setAside)} ${setAside.length === 1 ? "was" : "were"} removed, so ${its(setAside)} challenge${setAside.length === 1 ? " no longer counts" : "s no longer count"}` : "";
  return { status: "confirmed", rationale: `${tally}${answered}${doubt}${removed}${early}.`, dissenters: [] };
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
  const failed = review.reviewers.filter((reviewer) => reviewer.enabled && reviewer.status === "failed");
  const dropped = failed.length > 0 ? ` ${names(failed)} failed and couldn't continue.` : "";
  // Without a deliberation (rounds is set when one starts), every finding is still as reported.
  if (review.rounds === 0) {
    return `${findings.length} finding${findings.length === 1 ? "" : "s"}, not deliberated: fewer than two reviewers finished their review.${dropped}`;
  }
  // A finding the synthesis left reported had no backing left to stand on; it is counted, not dropped from the verdict.
  const unsettled = count("reported");
  const parts = (["agreed", "confirmed", "disputed", "withdrawn"] as const).filter((status) => count(status) > 0).map((status) => `${count(status)} ${status}`);
  if (unsettled > 0) parts.push(`${unsettled} unsettled`);
  const head = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  // Findings more than one reviewer reported on its own, before anyone saw the others' findings.
  const shared = findings.filter((finding) => reportersOf(finding).length > 1).length;
  const independent = shared > 0 ? ` ${shared} ${shared === 1 ? "was" : "were"} found independently by more than one reviewer.` : "";
  const held = serious > 0 ? ` ${serious} serious finding${serious === 1 ? " stands" : "s stand"}.` : contested > 0 ? " No serious finding is agreed or confirmed." : " No serious finding stands.";
  // Kept as it was at the verdict (the hand-off quotes it), so it states the outcome rather than what is left to do.
  const open = contested > 0 ? ` ${contested} serious finding${contested === 1 ? " is" : "s are"} disputed.` : "";
  const unbacked = unsettled > 0 ? ` ${unsettled === 1 ? "1 finding was" : `${unsettled} findings were`} left unsettled, with no one backing ${unsettled === 1 ? "it" : "them"}.` : "";
  return head + independent + held + open + unbacked + dropped;
}
