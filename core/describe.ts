/** A review in words, for an agent: what the host's tools answer, and what it hears when a review ends. */
import { argumentsOn, isFinished, seatedReviewers, type Finding, type Review } from "./model.ts";
import { PROFILES } from "./profiles.ts";
import { SEVERITIES } from "./schemas.ts";

const PHASE_WORDS: Record<Review["phase"], string> = {
  setup: "being set up (the user starts it from the canvas)",
  "independent-review": "running: reviewers are working independently",
  deliberation: "in deliberation: reviewers are arguing over the findings",
  synthesis: "in synthesis: the council is settling each finding",
  verification: "re-checking fixes: reviewers verify the fixes reported",
  complete: "complete",
  stopped: "stopped by the user",
  interrupted: "interrupted (Mirador restarted while it ran)",
};

export const bySeverity = (a: Finding, b: Finding) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

const evidenceText = (finding: Finding) =>
  finding.evidence.map((evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}`).join(", ");

/** One line for the canvas's bar: how many findings, how many of them serious, and with a verdict how they were settled. */
export function outcomeOf(review: Review): string | undefined {
  if (review.phase === "setup") return "setup";
  if (review.phase === "deliberation") return `deliberating · round ${review.round} of ${review.rounds}`;
  if (review.phase === "synthesis") return "settling the findings";
  if (review.phase === "verification") return "re-checking fixes";
  const fixes = review.findings.filter((finding) => finding.fix);
  if (fixes.length > 0) {
    const state = (state: string) => fixes.filter((finding) => finding.fix!.state === state).length;
    const parts = [`${state("verified")} verified`, state("reopened") > 0 ? `${state("reopened")} reopened` : "", `${fixes.length - state("verified") - state("reopened")} open`].filter(Boolean);
    return `fixes: ${parts.join(", ")}`;
  }
  const settledCount = (status: Finding["status"]) => review.findings.filter((finding) => finding.status === status).length;
  if (review.verdict && review.findings.some((finding) => finding.resolution)) {
    const standing = review.findings.filter((finding) => finding.status === "confirmed" || finding.status === "agreed").length;
    const disputed = settledCount("disputed");
    return `${standing} standing${disputed > 0 ? `, ${disputed} disputed` : ""}`;
  }
  const serious = review.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;
  const count = `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`;
  const tail = serious > 0 ? `, ${serious} serious` : "";
  return isFinished(review) ? `${count}${tail}` : `running · ${count}`;
}

export function describeReview(review: Review): string {
  const reviewers = seatedReviewers(review);
  const lines = [
    `Spectra Council review ${review.id} of ${review.target}: ${PROFILES[review.profile].title} profile, ${review.depth} depth, ${PHASE_WORDS[review.phase]}.`,
    review.runner === "mock"
      ? "Its reviewers are deterministic mocks: their findings are illustrative, not an analysis of the files."
      : review.runner === "mixed"
        ? "Some of its reviewers are deterministic mocks: their findings are illustrative, not an analysis of the files."
        : "",
    review.rounds > 0 ? `Deliberation: round ${review.round} of ${review.rounds}, ${review.arguments.length} arguments.` : "",
    review.verdict ? `Verdict: ${review.verdict.summary}` : "",
    review.handoff ? `Hand-off: ${review.handoff.path} (${review.handoff.findingIds.join(", ")}).` : "",
    `Reviewers: ${reviewers.map((reviewer) => `${reviewer.label} (${reviewer.status}${reviewer.problem ? `: ${reviewer.problem}` : ""})`).join(", ") || "none seated"}.`,
  ].filter(Boolean);
  if (review.findings.length === 0) return [...lines, "No findings yet."].join("\n");
  const label = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;
  lines.push(`Findings (${review.findings.length}):`);
  for (const finding of [...review.findings].sort(bySeverity)) {
    lines.push(
      `- ${finding.id} [${finding.severity}, ${finding.confidence} confidence, ${finding.status}] ${finding.title} — by ${label(finding.reviewerId)}; ${finding.category}; at ${evidenceText(finding)}. ${finding.summary}${finding.recommendation ? ` Fix: ${finding.recommendation}` : ""}`,
    );
    if (finding.resolution) lines.push(`  Council: ${finding.resolution.rationale}`);
    if (finding.proposal) lines.push(`  Proposed fix (by ${label(finding.proposal.drafterId)}): ${finding.proposal.summary} Steps: ${finding.proposal.steps.join(" / ")}. Verify: ${finding.proposal.verification}`);
    if (finding.ruling) lines.push(`  User ruling: ${finding.ruling.decision}${finding.ruling.note ? ` (${finding.ruling.note})` : ""}`);
    if (finding.fix) {
      lines.push(`  Fix: ${finding.fix.state}${finding.fix.summary ? `: ${finding.fix.summary}` : ""}${finding.fix.files.length ? ` (${finding.fix.files.join(", ")})` : ""}`);
      for (const check of finding.fix.checks) lines.push(`  Re-check ${check.pass}, ${label(check.reviewerId)} ${check.outcome}: ${check.text}`);
    }
    for (const argument of argumentsOn(review, finding.id)) {
      lines.push(`  ${argument.id} round ${argument.round}, ${label(argument.reviewerId)} ${argument.stance}${argument.replyTo ? ` (answering ${argument.replyTo})` : ""}: ${argument.text}`);
    }
  }
  return lines.join("\n");
}

/** What each finding status means, in a sentence, for a tooltip or legend. */
export const STATUS_MEANINGS: Record<Finding["status"], string> = {
  reported: "Reported; the council hasn't settled it yet.",
  agreed: "Agreed: every reviewer who weighed in backs it, and nobody challenged it.",
  confirmed: "Confirmed: most back it, and every challenge to it was answered.",
  disputed: "Disputed: a challenge still stands. Your ruling decides it.",
  withdrawn: "Withdrawn: its reporter conceded it isn't a problem.",
};

/** How the latest re-check of fixes came out, e.g. "After re-check 1: 4 verified, 3 reopened."; null before one. */
export function recheckLine(review: Review): string | null {
  if (review.verifications === 0) return null;
  const fixes = review.findings.filter((finding) => finding.fix?.checks.some((check) => check.pass === review.verifications));
  if (fixes.length === 0) return null;
  const verified = fixes.filter((finding) => finding.fix!.state === "verified").length;
  const reopened = fixes.filter((finding) => finding.fix!.state === "reopened").length;
  const parts = [verified > 0 ? `${verified} verified` : "", reopened > 0 ? `${reopened} reopened` : ""].filter(Boolean);
  return `After re-check ${review.verifications}: ${parts.join(", ") || "nothing settled"}.`;
}

const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Whether an argument says its finding is the same as another: "the same as F6", "a duplicate of F6", "F6 again". */
const SAYS_SAME = /\b(same|duplicates?|identical|again)\b/i;

/**
 * Other findings that are probably the same problem, until the council merges duplicates: the same title, or one that an
 * argument about either finding names as the same ("I found the same independently in F6"). Symmetric: if F2 is a
 * possible duplicate of F6, F6 is one of F2.
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
