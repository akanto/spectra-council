/** A review in words, for an agent: what the host's tools answer, and what it hears when a review ends. */
import { isFinished, seatedReviewers, type Finding, type Review } from "./model.ts";
import { PROFILES } from "./profiles.ts";
import { SEVERITIES } from "./schemas.ts";

const PHASE_WORDS: Record<Review["phase"], string> = {
  setup: "being set up (the user starts it from the canvas)",
  "independent-review": "running: reviewers are working independently",
  deliberation: "in deliberation",
  synthesis: "in synthesis",
  complete: "complete",
  stopped: "stopped by the user",
  interrupted: "interrupted (Mirador restarted while it ran)",
};

export const bySeverity = (a: Finding, b: Finding) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);

const evidenceText = (finding: Finding) =>
  finding.evidence.map((evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}`).join(", ");

/** One line for the canvas's bar: how many findings, how many of them serious. */
export function outcomeOf(review: Review): string | undefined {
  if (review.phase === "setup") return "setup";
  const serious = review.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;
  const count = `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`;
  const tail = serious > 0 ? `, ${serious} serious` : "";
  return isFinished(review) ? `${count}${tail}` : `running · ${count}`;
}

export function describeReview(review: Review): string {
  const reviewers = seatedReviewers(review);
  const lines = [
    `Spectra Council review ${review.id} of ${review.target}: ${PROFILES[review.profile].title} profile, ${review.depth} depth, ${PHASE_WORDS[review.phase]}.`,
    review.runner === "mock" ? "Its reviewers are deterministic mocks: their findings are illustrative, not an analysis of the files." : "",
    `Reviewers: ${reviewers.map((reviewer) => `${reviewer.label} (${reviewer.status}${reviewer.problem ? `: ${reviewer.problem}` : ""})`).join(", ") || "none seated"}.`,
  ].filter(Boolean);
  if (review.findings.length === 0) return [...lines, "No findings yet."].join("\n");
  const label = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;
  lines.push(`Findings (${review.findings.length}):`);
  for (const finding of [...review.findings].sort(bySeverity)) {
    lines.push(
      `- ${finding.id} [${finding.severity}, ${finding.confidence} confidence, ${finding.status}] ${finding.title} — by ${label(finding.reviewerId)}; ${finding.category}; at ${evidenceText(finding)}. ${finding.summary}${finding.recommendation ? ` Fix: ${finding.recommendation}` : ""}`,
    );
  }
  return lines.join("\n");
}
