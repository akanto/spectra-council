/**
 * A research council's answer file as Markdown: the editor's latest draft, the council's objections to the first draft
 * when the editor revised after them, and the ledger of every claim with its sources and their checks. Pure and
 * deterministic: the same review gives the same text.
 */
import { shortName } from "./agents.ts";
import { digestOf } from "./handoff.ts";
import type { Claim, ClaimStatus, Review, Source } from "./model.ts";
import { claimReportersOf } from "./model.ts";

/** A claim's status in a short phrase, for the ledger and the view. */
export function claimStatusText(claim: Pick<Claim, "status" | "ruling">): string {
  if (claim.ruling?.decision === "struck") return "struck by the user";
  const words: Record<ClaimStatus, string> = {
    reported: "not deliberated",
    agreed: "agreed",
    confirmed: "confirmed",
    disputed: "disputed",
    withdrawn: "withdrawn by its reporter",
    unverified: "unverified: no source was verified",
  };
  return words[claim.status];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const isoDate = (at: number) => new Date(at).toISOString().slice(0, 10);

function sourceLines(source: Source, index: number, who: (id: string) => string): string[] {
  const head = [source.authors, `"${source.title}"`, source.venue, source.year ? String(source.year) : ""].filter(Boolean).join(", ");
  const lines = [`  - Source ${index + 1}: ${head}. ${source.url}${source.doi ? ` (DOI ${source.doi})` : ""}; read: ${source.read}.`];
  lines.push(`    Quote${source.locator ? ` (${source.locator})` : ""}: "${oneLine(source.quote)}"`);
  if (source.checks.length === 0) lines.push("    Checks: none.");
  for (const check of source.checks) lines.push(`    Check by ${who(check.reviewerId)}: ${check.outcome}. ${oneLine(check.note)}`);
  return lines;
}

/** The answer file: title, provenance, the latest draft (with the council's objections to its first version), the ledger. */
export function answerMarkdown(review: Review): string {
  const research = review.research;
  if (!research) return "";
  const who = (id: string) => {
    const reviewer = review.reviewers.find((each) => each.id === id);
    return reviewer ? shortName(reviewer) : id;
  };
  const seats = review.reviewers.filter((reviewer) => reviewer.enabled).map((reviewer) => `${shortName(reviewer)}${reviewer.id === research.editor ? " (editor)" : ""}`);
  const briefName = research.brief ? research.brief.slice(research.brief.lastIndexOf("/") + 1).replace(/\.(md|markdown|txt)$/i, "") : "";
  const title = briefName ? `Answer to ${briefName}` : "Research answer";
  const deliberated = review.rounds > 0 ? "deliberated in rounds" : "not deliberated (a single seat, or no rounds)";
  const out: string[] = [`# ${title}`, "", `Written by Spectra Council research council ${review.id}; seats: ${seats.join(", ") || "none"}; ${deliberated}.`, ""];
  if (!research.brief && research.question) out.push(`Question: ${oneLine(research.question)}`, "");

  const draft = research.drafts.at(-1);
  if (draft) {
    const objections = research.objections.filter((objection) => objection.pass === draft.pass && objection.revision === 0);
    if (objections.length > 0 && draft.revision > 0) {
      out.push("## Council objections to the first draft", "");
      for (const objection of objections) out.push(`- ${who(objection.reviewerId)}${objection.claimId ? ` on ${objection.claimId}` : ""}: "${oneLine(objection.excerpt)}" — ${oneLine(objection.problem)}`);
      out.push("", "The editor revised the draft once after these objections. Check that the answer below addresses them.", "");
    }
    if (draft.problems.length > 0) {
      out.push("> **Warning: the latest draft has problems with the ledger.**", ...draft.problems.map((problem) => `> - ${problem}`), "");
    }
    out.push(draft.markdown.trim(), "");
  } else {
    out.push("No answer was drafted; the ledger of claims is below.", "");
  }

  out.push("## Ledger", "");
  const rqs = [...new Set(research.claims.map((claim) => claim.rq))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : 0));
  if (research.claims.length === 0) out.push("No claims were reported.", "");
  for (const rq of rqs) {
    out.push(`### ${rq || "Other"}`, "");
    for (const claim of research.claims.filter((each) => each.rq === rq)) {
      const followUp = claim.pass > 0 ? ` (follow-up ${claim.pass}: ${research.followUps.find((each) => each.pass === claim.pass)?.question ?? ""})` : "";
      out.push(`#### ${claim.id} [${claim.kind}, ${claimStatusText(claim)}] ${claim.title}${followUp}`, "");
      if (claim.ruling?.decision === "struck") out.push(`Struck by the user${claim.ruling.note ? `: ${oneLine(claim.ruling.note)}` : "."}`, "");
      out.push(claim.text.trim(), "");
      const fields = Object.entries(claim.fields);
      if (fields.length > 0) out.push(`Fields: ${fields.map(([name, value]) => `${name}: ${value}`).join("; ")}`);
      const reporters = claimReportersOf(claim).map(who);
      out.push(`Reported by ${reporters.join(", ")}; confidence ${claim.confidence}.`);
      for (const report of claim.alsoReported) out.push(`Also reported as ${report.claimId} ("${report.title}") by ${who(report.reviewerId)}.`);
      if (claim.sources.length > 0) {
        out.push("", "Sources:");
        claim.sources.forEach((source, index) => out.push(...sourceLines(source, index, who)));
      }
      if (claim.resolution) {
        out.push("", `Council: ${oneLine(claim.resolution.rationale)}`);
        for (const dissent of claim.resolution.dissent ?? []) if (dissent.reason) out.push(`Dissent (${who(dissent.reviewerId)}): ${oneLine(dissent.reason)}`);
      }
      out.push("");
    }
  }
  const written = draft ? `Draft revision ${draft.revision} by ${who(draft.editorId)}, ${isoDate(draft.at)}.` : "";
  if (written) out.push("---", written, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export const answerDigest = (review: Review): string => digestOf(answerMarkdown(review));
