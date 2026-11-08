/**
 * The hand-off document: what the council concluded and how, for the accepted findings, with the proposed fixes, so an
 * agent (or a person) can act on it without the canvas. Pure Markdown from a review; the host decides where it goes.
 */
import { knobsText } from "./depth.ts";
import { bySeverity } from "./describe.ts";
import { argumentsOn, type Argument, type Finding, type Review } from "./model.ts";
import type { Evidence } from "./schemas.ts";

/** Where a review's hand-off goes, relative to the folder of its target. */
export const handoffFile = (review: Review) => `.spectra-council/review-${review.id}.md`;

/** The accepted findings, most severe first. */
export const acceptedFindings = (review: Review) => review.findings.filter((finding) => finding.ruling?.decision === "accepted").sort(bySeverity);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const isoDate = (at: number) => new Date(at).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const place = (evidence: Evidence) => {
  const line = evidence.line === undefined ? "" : evidence.endLine !== undefined && evidence.endLine !== evidence.line ? `:${evidence.line}-${evidence.endLine}` : `:${evidence.line}`;
  return `${evidence.path}${line}`;
};

/** A markdown list of evidence: the place in code format, the note, and the quote below it. */
function evidenceLines(list: Evidence[], indent = ""): string[] {
  return list.flatMap((evidence) => {
    const note = evidence.note ? `: ${oneLine(evidence.note)}` : "";
    const quote = evidence.quote ? [`${indent}  > ${oneLine(evidence.quote)}`] : [];
    return [`${indent}- \`${place(evidence)}\`${note}`, ...quote];
  });
}

export function handoffMarkdown(review: Review): string {
  const label = (reviewerId: string) => review.reviewers.find((reviewer) => reviewer.id === reviewerId)?.label ?? reviewerId;
  const accepted = acceptedFindings(review);
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  const out: string[] = [];

  out.push(`# Spectra Council hand-off: review ${review.id}`, "");
  out.push(`- Target: \`${review.target}\``);
  out.push(`- Profile: ${review.profile}; depth: ${review.depth} (${knobsText(review)})`);
  out.push(`- Council: ${plural(seated.length, "reviewer")} (${seated.map((reviewer) => reviewer.label).join(", ")}), ${plural(review.rounds, "deliberation round")}`);
  if (review.verdict) out.push(`- Date: ${isoDate(review.verdict.at)}`);
  if (review.runner === "mock") out.push("- Note: the reviewers in this review are deterministic mocks, not real agents; the findings are illustrative.");
  if (review.runner === "mixed") out.push("- Note: some reviewers in this review are deterministic mocks; their findings are illustrative.");
  out.push("");
  out.push("## Verdict", "", review.verdict ? oneLine(review.verdict.summary) : "The council has not given a verdict.", "");
  out.push("## How to use this", "");
  out.push(`This file lists the ${plural(accepted.length, "finding")} the user accepted. Each is to be fixed in the target folder above.`, "");
  out.push("- Fix the findings in the order listed, most severe first.");
  out.push("- Each section gives the evidence, how the council reasoned, the proposed fix and how to verify it. Treat the proposed fix as a starting point; check it against the code.");
  out.push("- Do not touch the findings listed under \"Not to fix\".");
  out.push(
    "- Report each fix as the message that handed you this file says: in the review's own conversation, with the `council_mark_fixed` tool; in a conversation started for the fix, in the JSON report your final message ends with. Either way: the finding id, what you changed, and the files.",
  );
  out.push("");

  out.push("## Findings to fix", "");
  if (accepted.length === 0) out.push("No finding was accepted.", "");
  else {
    out.push("| Id | Severity | Council | Title |", "| --- | --- | --- | --- |");
    for (const finding of accepted) out.push(`| ${finding.id} | ${finding.severity} | ${finding.status} | ${oneLine(finding.title).replace(/\|/g, "\\|")} |`);
    out.push("");
  }

  const entry = (argument: Argument) => {
    const cited = argument.evidence.length > 0 ? ` (cites ${argument.evidence.map(place).join(", ")})` : "";
    return `${label(argument.reviewerId)}, ${argument.stance}, ${argument.confidence} confidence: ${oneLine(argument.text)}${cited}`;
  };

  for (const finding of accepted) {
    out.push(`## ${finding.id}: ${oneLine(finding.title)}`, "");
    out.push(`- Severity: ${finding.severity}; category: ${finding.category}; council status: ${finding.status}`);
    out.push(`- Reported by: ${label(finding.reviewerId)}, ${finding.confidence} confidence`);
    if (finding.ruling?.note.trim()) out.push(`- The user's note: ${oneLine(finding.ruling.note)}`);
    out.push("");
    out.push("### What's wrong", "", oneLine(finding.summary), "");
    const timeline = argumentsOn(review, finding.id);
    if (finding.status === "disputed") {
      out.push("### Minority report", "");
      const dissenters = finding.resolution?.dissenters ?? [];
      out.push(`This finding is disputed. A challenge by ${dissenters.length > 0 ? dissenters.map(label).join(", ") : "a reviewer"} still stands; weigh it before you change anything.`, "");
      const standing = dissenters.length > 0
        ? dissenters.flatMap((id) => {
            const latest = timeline.filter((argument) => argument.reviewerId === id && argument.stance === "challenges").at(-1);
            return latest ? [latest] : [];
          })
        : timeline.filter((argument) => argument.stance === "challenges" && argument.reviewerId !== finding.reviewerId);
      for (const argument of standing) {
        out.push(`> ${label(argument.reviewerId)} (round ${argument.round}): ${oneLine(argument.text)}`);
        for (const evidence of argument.evidence) out.push(`> - \`${place(evidence)}\`${evidence.note ? `: ${oneLine(evidence.note)}` : ""}`);
        out.push(">");
      }
      if (out[out.length - 1] === ">") out.pop();
      out.push("");
    }

    out.push("### Evidence", "", ...evidenceLines(finding.evidence), "");

    out.push("### How the council got there", "");
    out.push(finding.resolution ? oneLine(finding.resolution.rationale) : "The council did not settle this finding.", "");
    const rounds = [...new Set(timeline.map((argument) => argument.round))].sort((a, b) => a - b);
    for (const round of rounds) {
      out.push(`Round ${round}:`);
      for (const argument of timeline.filter((each) => each.round === round)) out.push(`- ${entry(argument)}`);
      out.push("");
    }
    out.push("### Proposed fix", "");
    const proposal = finding.proposal;
    if (proposal) {
      out.push(oneLine(proposal.summary), "");
      proposal.steps.forEach((step, index) => out.push(`${index + 1}. ${oneLine(step)}`));
      out.push("");
      if (proposal.files.length > 0) out.push(`Files: ${proposal.files.map((file) => `\`${file}\``).join(", ")}`, "");
      out.push(`How to verify: ${oneLine(proposal.verification)}`, "");
      if (proposal.risks) out.push(`Risks: ${oneLine(proposal.risks)}`, "");
    } else {
      out.push("No fix was proposed." + (finding.recommendation ? " The reporting reviewer recommended:" : ""), "");
      if (finding.recommendation) out.push(oneLine(finding.recommendation), "");
    }

    const fix = finding.fix;
    if (fix) {
      out.push("### Fix status", "", `State: ${fix.state}.`);
      if (fix.summary) out.push(`Reported change: ${oneLine(fix.summary)}`);
      if (fix.files.length > 0) out.push(`Files changed: ${fix.files.map((file) => `\`${file}\``).join(", ")}`);
      out.push("");
      const reopened = fix.checks.filter((check) => check.outcome === "reopened");
      if (reopened.length > 0) {
        out.push("The council re-checked an earlier fix and reopened this finding. What was wrong with it:", "");
        for (const check of reopened) {
          out.push(`- ${label(check.reviewerId)} (check ${check.pass}): ${oneLine(check.text)}`);
          out.push(...evidenceLines(check.evidence, "  "));
        }
        out.push("");
      }
    }
  }

  const others = review.findings.filter((finding) => finding.ruling && finding.ruling.decision !== "accepted");
  if (others.length > 0) {
    out.push("## Not to fix", "", "The user dismissed or deferred these. Leave them alone.", "");
    for (const finding of others) {
      const ruling = finding.ruling!;
      out.push(`- ${finding.id} (${ruling.decision}): ${oneLine(finding.title)}${ruling.note.trim() ? ` - ${oneLine(ruling.note)}` : ""}`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
