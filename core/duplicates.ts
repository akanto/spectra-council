/**
 * Findings that report the same problem. After the independent review the engine merges the clear cases
 * (`duplicateGroups`): the same title, or the same kind of problem at the same place. Then, with a real agent at the
 * council, one agent groups the rest by meaning (the grouping turn; `keeperOf` and `currentFinding` turn its groups into
 * merges). Looser matches, which an argument points out ("the same as F6"), are only linked for the user
 * (`possibleDuplicates`).
 */
import type { Finding, Review } from "./model.ts";
import { SEVERITIES } from "./schemas.ts";

/** A title reduced to its words, for comparing: case and punctuation don't count. */
export const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** How close two cited lines must be to count as the same place. */
const NEARBY_LINES = 3;

/** The words of a title that carry meaning: four letters or more, so "the", "not", "and" don't count. */
const titleWords = (title: string) => new Set(titleKey(title).split(" ").filter((word) => word.length >= 4));

/** Whether two titles are alike: at least two meaningful words in common, and half of all their words. */
function similarTitles(a: string, b: string): boolean {
  const [left, right] = [titleWords(a), titleWords(b)];
  const shared = [...left].filter((word) => right.has(word)).length;
  const all = new Set([...left, ...right]).size;
  return shared >= 2 && shared / all >= 0.5;
}

/**
 * Whether two findings clearly report the same problem: the same title in the same file; or the same category at the same place (the
 * first evidence on the same file, within a few lines) with alike titles (two or more meaningful words in common, half
 * of all). Two problems can sit on one line, so the place alone isn't enough.
 */
export function sameProblem(a: Finding, b: Finding): boolean {
  // A generic title ("Missing error handling") recurs for different problems: an equal title counts in the same file.
  const paths = new Set(a.evidence.map((evidence) => evidence.path));
  if (titleKey(a.title) === titleKey(b.title)) return b.evidence.some((evidence) => paths.has(evidence.path));
  if (a.category.toLowerCase() !== b.category.toLowerCase() || !similarTitles(a.title, b.title)) return false;
  const [first, second] = [a.evidence[0], b.evidence[0]];
  if (!first || !second || first.path !== second.path || first.line === undefined || second.line === undefined) return false;
  const [aEnd, bEnd] = [first.endLine ?? first.line, second.endLine ?? second.line];
  return first.line <= bEnd + NEARBY_LINES && second.line <= aEnd + NEARBY_LINES;
}

const severityRank = (finding: Finding) => SEVERITIES.indexOf(finding.severity);

/** The finding a group of duplicates merges into: the most severe, the earliest reported among equals. */
export function keeperOf(review: Review, group: Finding[]): Finding {
  const order = (finding: Finding) => review.findings.indexOf(finding);
  return group.reduce((best, each) => (severityRank(each) < severityRank(best) || (severityRank(each) === severityRank(best) && order(each) < order(best)) ? each : best));
}

/** The finding an id names now: the finding itself, or the one its report was merged into; undefined for neither. */
export const currentFinding = (review: Review, id: string): Finding | undefined =>
  review.findings.find((finding) => finding.id === id) ?? review.findings.find((finding) => finding.alsoReported.some((report) => report.findingId === id));

/**
 * The findings to merge: groups of two or more that report the same problem (linked through `sameProblem`, so A~B and
 * B~C group all three). Each group keeps its most severe finding, the earliest among equals; the others merge into it.
 */
export function duplicateGroups(review: Review): { into: string; merged: string[] }[] {
  const findings = review.findings;
  const group = findings.map((_, index) => index);
  const root = (index: number): number => (group[index] === index ? index : (group[index] = root(group[index]!)));
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) if (sameProblem(findings[i]!, findings[j]!)) group[root(j)] = root(i);
  }
  const members = new Map<number, Finding[]>();
  findings.forEach((finding, index) => members.set(root(index), [...(members.get(root(index)) ?? []), finding]));
  return [...members.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const keeper = keeperOf(review, list);
      return { into: keeper.id, merged: list.filter((each) => each !== keeper).map(({ id }) => id) };
    });
}

/** Whether an argument says its finding is the same as another: "the same as F6", "a duplicate of F6", "F6 again". */
const SAYS_SAME = /\b(same|duplicates?|identical|again)\b/i;

/**
 * Other findings that are probably the same problem but weren't merged: the same title, or one that an argument about
 * either finding names as the same ("I found the same independently in F6"). Symmetric: if F2 is a possible duplicate
 * of F6, F6 is one of F2.
 */
export function possibleDuplicates(review: Review, finding: Finding): Finding[] {
  const key = titleKey(finding.title);
  const linked = new Set<string>();
  for (const argument of review.arguments) {
    if (!SAYS_SAME.test(argument.text)) continue;
    const named = [...argument.text.matchAll(/\bF\d+\b/g)].map((match) => match[0]);
    if (argument.findingId === finding.id) named.forEach((id) => linked.add(id));
    else if (named.includes(finding.id)) linked.add(argument.findingId);
  }
  return review.findings.filter((other) => other.id !== finding.id && (titleKey(other.title) === key || linked.has(other.id)));
}
