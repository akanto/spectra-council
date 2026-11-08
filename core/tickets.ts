/**
 * What the conversation's agent is asked to do with the accepted findings besides fixing them: file a beads issue for
 * each (for repos that track their work in beads), or whatever the user wrote in their own words. Pure: the host
 * sends the prompts and the agent reports back through tools.
 */
import { idsInTitle, turnTitle } from "./agent-turns.ts";
import { bySeverity } from "./describe.ts";
import { ASK_REPORT_EXAMPLE } from "./fixer.ts";
import type { Finding, Review } from "./model.ts";
import type { Severity } from "./schemas.ts";

/** A finding's severity as a beads priority: 0 critical to 4 backlog. */
export const BEADS_PRIORITY: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const isAccepted = (finding: Finding) => finding.ruling?.decision === "accepted";
const isDone = (finding: Finding) => finding.fix?.state === "fixed" || finding.fix?.state === "verified";

/**
 * Accepted findings with no ticket asked for yet, most severe first: the ones "Write beads tickets" files. A finding
 * fixed or verified already needs no ticket.
 */
export const unticketed = (review: Review): Finding[] => review.findings.filter((finding) => isAccepted(finding) && !finding.ticket && !isDone(finding)).sort(bySeverity);

/** Accepted findings whose ticket was asked for and not reported yet, most severe first. */
export const waitingTickets = (review: Review): Finding[] => review.findings.filter((finding) => isAccepted(finding) && finding.ticket?.id === null).sort(bySeverity);

/** The accepted findings, most severe first: what a custom ask is about. */
const acceptedOf = (review: Review): Finding[] => review.findings.filter((finding) => finding.ruling?.decision === "accepted").sort(bySeverity);

const list = (findings: Finding[]) => findings.map((finding) => `- ${finding.id} (${finding.severity}, beads priority ${BEADS_PRIORITY[finding.severity]}): ${finding.title.replace(/\s+/g, " ").trim()}`).join("\n");

/** Asks the agent to file one beads issue per finding in `ids`, by the hand-off, and report each id back. */
export function ticketsPrompt(review: Review, ids: string[], handoffPath: string, workspace: string): string {
  const findings = review.findings.filter((finding) => ids.includes(finding.id)).sort(bySeverity);
  return [
    `Please file one beads (bd) issue for each of these accepted findings from Spectra Council review ${review.id}, in the beads workspace at ${workspace}. Don't fix them now.`,
    list(findings),
    `The hand-off at ${handoffPath} has, for each finding, what's wrong, the evidence, how the council reached its conclusion (including any dissent) and the proposed fix with how to verify it.`,
    [
      "For each finding, run bd create (from the workspace's folder) with:",
      "- --title: the finding's title;",
      "- --type=bug, or --type=task where it is not a defect;",
      "- --priority: the beads priority given above (from the severity);",
      "- --description: what's wrong and the failure scenario, the evidence as path:line, and a final line \"From Spectra Council review " + review.id + ", finding <id> (hand-off: " + handoffPath + ")\";",
      "- --design: the proposed fix, its steps and how to verify it, where the council proposed one.",
    ].join("\n"),
    `Before filing each, check it isn't filed already: bd search --desc-contains "review ${review.id}, finding <id>" (and bd search for its title). If it is, report that issue's id instead of filing a new one.`,
    `After each one, call council_mark_ticketed with review "${review.id}", the finding id and the issue id, so the canvas shows it on the finding.`,
  ].join("\n\n");
}

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const handoffLine = (handoffPath: string) =>
  `The hand-off at ${handoffPath} has, for each one, what's wrong, the evidence, how the council reached its conclusion (including any dissent) and the proposed fix with how to verify it.`;

/** Sends the user's own instruction about the accepted findings, with the findings and the hand-off, to the agent. */
export function askPrompt(review: Review, text: string, handoffPath: string): string {
  return [
    `The user asks about the accepted findings of Spectra Council review ${review.id}, in their own words:`,
    quote(text),
    `The accepted findings, most severe first:\n${list(acceptedOf(review))}`,
    `${handoffLine(handoffPath)} council_status has the whole review.`,
    `Do what the user asks, only for these findings. If you fix one, call council_mark_fixed with review "${review.id}", the finding id, what you changed and the files; if you file a beads issue for one, call council_mark_ticketed with review "${review.id}", the finding id and the issue id.`,
  ].join("\n\n");
}

/**
 * The first message of the fixer profile's conversation for the user's own ask (`asks[index]`): the same instruction,
 * reported back in a JSON block, since that conversation can't reach the review's canvas.
 */
export function askFixerPrompt(review: Review, index: number, handoffPath: string): string {
  const ask = review.asks?.[index];
  if (!ask) throw new Error(`Review ${review.id} has no ask ${index}.`);
  const findings = review.findings.filter((finding) => ask.findingIds.includes(finding.id)).sort(bySeverity);
  return [
    turnTitle(review, `Ask about ${idsInTitle(findings.map(({ id }) => id))}`),
    `A Spectra Council review (${review.id}) of ${review.target} is complete. The user asks about its accepted findings, in their own words:`,
    quote(ask.text),
    `The accepted findings, most severe first:\n${list(findings)}`,
    handoffLine(handoffPath),
    `Do what the user asks, only for these findings; leave the ones the hand-off lists under "Not to fix" alone. If you file beads issues, check first that each isn't filed already (bd search --desc-contains "review ${review.id}, finding <id>").`,
    `You can't report to the review directly. When you are done, end your final message with this JSON block: each finding you fixed under "fixed", each you were asked to fix and didn't under "notFixed", each beads issue you filed under "tickets"; leave out what the user didn't ask for.`,
    ASK_REPORT_EXAMPLE,
  ].join("\n\n");
}
