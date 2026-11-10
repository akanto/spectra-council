/** A review in words, for an agent: what the host's tools answer, and what it hears when a review ends. */
import { knobsText } from "./depth.ts";
import type { WhenFetchable } from "./late-replies.ts";
import { argumentsOn, isFinished, seatedReviewers, type Finding, type Review, type Reviewer } from "./model.ts";
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
  interrupted: "interrupted (Mirador restarted while it ran; the user can resume it in the canvas)",
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

/**
 * What the review's own conversation hears when a run of it reaches its verdict: its outcome as the canvas's bar shows it
 * (how the findings settled, or the fixes after a re-check), how many reviewers failed, and the ask to tell the user.
 */
export function finishedPrompt(review: Review): string {
  const seated = seatedReviewers(review);
  const failed = seated.filter((reviewer) => reviewer.status === "failed").length;
  const failures = failed > 0 ? `; ${failed} of its ${seated.length} reviewers failed` : "";
  return `Spectra Council review ${review.id} is finished (${outcomeOf(review)}${failures}). Tell the user in one or two lines what came of it, without calling any council tool.`;
}

/**
 * What the review's own conversation hears when a reviewer's reply comes in after its turn's limit gave up on it: that
 * the user can take it into the review — now, or in the window `whyNoFetch` will open: once the council at work
 * reaches its verdict, or, for a run a restart cut short, once the user resumes it — and the ask to tell the user. It's
 * told once, with the phase as it is then, so a later window says what becomes of the reply if the review never gets
 * there: a stopped review refuses the fetch.
 */
export function lateReplyPrompt(review: Review, reviewer: Reviewer, fetchable: WhenFetchable): string {
  const when: Record<WhenFetchable, string> = {
    now: "",
    "once complete": ` once the review reaches its verdict; if it never gets there, the reply stays only in ${reviewer.label}'s own conversation`,
    "once resumed": ` once the user resumes it (Mirador restarted while it ran), while the reviewers review or once the review is complete`,
  };
  return `Spectra Council review ${review.id}: ${reviewer.label}'s reply came in after its turn had timed out. The user can take it into the review with "Fetch its reply" on the canvas${when[fetchable]}. Tell the user in one line, without calling any council tool.`;
}

/**
 * What the conversation that started a fixer hears when it comes back: what it fixed and didn't, with the reasons, the
 * beads issues it filed for what it couldn't fix, and the ask to tell the user.
 */
export function fixerFinishedPrompt(review: Review, profile: string, outcome: { fixed: string[]; notFixed: { finding: string; reason: string }[]; tickets: { finding: string; ticket: string }[]; problem: string | null }): string {
  const left = outcome.notFixed.map(({ finding, reason }) => `${finding}: ${reason.replace(/\.$/, "")}`).join("; ");
  const filed = outcome.tickets.map(({ finding, ticket }) => `${ticket} for ${finding}`).join("; ");
  return [
    `Spectra Council review ${review.id}: the fixer conversation on the "${profile}" profile is back.`,
    outcome.fixed.length > 0 ? `It fixed ${outcome.fixed.join(", ")}.` : "",
    filed ? `It filed ${filed}.` : "",
    outcome.notFixed.length > 0 ? `It didn't fix ${left}.` : "",
    outcome.problem ?? "",
    `Tell the user in one or two lines what came of it, without calling any council tool.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function describeReview(review: Review): string {
  const reviewers = seatedReviewers(review);
  const lines = [
    `Spectra Council review ${review.id} of ${review.target}: ${PROFILES[review.profile].title} profile, ${review.depth} depth (${knobsText(review)}), ${PHASE_WORDS[review.phase]}.`,
    review.runner === "mock" && reviewers.length > 0
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
      `- ${finding.id} [${finding.severity}, ${finding.confidence} confidence, ${finding.status}${finding.late ? ", came in late after the verdict" : ""}] ${finding.title} — by ${label(finding.reviewerId)}; ${finding.category}; at ${evidenceText(finding)}. ${finding.summary}${finding.recommendation ? ` Fix: ${finding.recommendation}` : ""}`,
    );
    if (finding.alsoReported.length > 0) lines.push(`  Also reported by: ${finding.alsoReported.map((report) => `${label(report.reviewerId)} as ${report.findingId} ("${report.title}")${report.mergedBy ? `, merged by ${label(report.mergedBy)}${report.reason ? `: ${report.reason}` : ""}` : ""}`).join(", ")}`);
    if (finding.resolution) lines.push(`  Council: ${finding.resolution.rationale}`);
    for (const dissent of finding.resolution?.dissent ?? []) if (dissent.reason) lines.push(`  ${label(dissent.reviewerId)} still challenges it: ${dissent.reason}`);
    if (finding.proposal) lines.push(`  Proposed fix (by ${label(finding.proposal.drafterId)}): ${finding.proposal.summary} Steps: ${finding.proposal.steps.join(" / ")}. Verify: ${finding.proposal.verification}`);
    if (finding.ruling) lines.push(`  User ruling: ${finding.ruling.decision}${finding.ruling.note ? ` (${finding.ruling.note})` : ""}`);
    if (finding.fix) {
      lines.push(`  Fix: ${finding.fix.state}${finding.fix.summary ? `: ${finding.fix.summary}` : ""}${finding.fix.files.length ? ` (${finding.fix.files.join(", ")})` : ""}`);
      if (finding.fix.problem) lines.push(`  ${finding.fix.state === "fixed" ? "Not re-checked" : "Not fixed"}: ${finding.fix.problem}`);
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
  reported: "Reported; the council hasn't settled it: not yet, or nobody backs it.",
  agreed: "Agreed: every reviewer who weighed in backs it, and nobody challenged it.",
  confirmed: "Confirmed: most back it, and every challenge to it was answered.",
  disputed: "Disputed: a challenge still stands. Your ruling decides it.",
  withdrawn: "Withdrawn: its reporter conceded it isn't a problem.",
};

/**
 * The fixes the latest re-check settled nothing about: put to it, and it ended with no check back (the reducer says so
 * in the fix's problem). A stopped re-check, or a fix reported again since, leaves none.
 */
export const unansweredFixes = (review: Review): Finding[] =>
  review.findings.filter((finding) => finding.fix?.state === "fixed" && finding.fix.recheckedIn === review.verifications && finding.fix.problem !== null);

/**
 * How the latest re-check of fixes came out, e.g. "After re-check 1: 4 verified, 3 reopened, 1 not re-checked."; null
 * before one.
 */
export function recheckLine(review: Review): string | null {
  if (review.verifications === 0) return null;
  const fixes = review.findings.filter((finding) => finding.fix?.checks.some((check) => check.pass === review.verifications));
  const unanswered = unansweredFixes(review).length;
  if (fixes.length === 0 && unanswered === 0) return null;
  const verified = fixes.filter((finding) => finding.fix!.state === "verified").length;
  const reopened = fixes.filter((finding) => finding.fix!.state === "reopened").length;
  const parts = [verified > 0 ? `${verified} verified` : "", reopened > 0 ? `${reopened} reopened` : "", unanswered > 0 ? `${unanswered} not re-checked` : ""].filter(Boolean);
  return `After re-check ${review.verifications}: ${parts.join(", ") || "nothing settled"}.`;
}

/** Kept here for the view, which reads findings in words from this module. */
export { possibleDuplicates } from "./duplicates.ts";
