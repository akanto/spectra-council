/**
 * Handing fixes to another profile's agent: the first message of the conversation started for it, and how its final
 * reply says what it fixed. That conversation can't reach the review's canvas, so it reports in its last message, as a
 * JSON block this reads. Pure: the host starts the conversation and applies what this reads.
 */
import { z } from "zod";
import type { Review } from "./model.ts";
import { idsInTitle, turnTitle } from "./agent-turns.ts";
import { lastJson } from "./replies.ts";
import { ticketIdSchema } from "./schemas.ts";

/** What the fixer ends its final message with, inside a ```json fence. */
export const fixerReportSchema = z.object({
  fixed: z
    .array(z.object({ finding: z.string().min(1), summary: z.string().min(1), files: z.array(z.string().min(1)).default([]) }))
    .default([]),
  notFixed: z.array(z.object({ finding: z.string().min(1), reason: z.string().min(1) })).default([]),
  /** Beads issues filed for findings: only read for the user's own ask, which may ask for them. */
  tickets: z
    .array(z.unknown())
    .default([])
    .transform((entries) =>
      // One malformed or unsafe ticket id drops just that entry: the report's fixes must still count.
      entries.flatMap((entry) => {
        const parsed = z.object({ finding: z.string().min(1), ticket: ticketIdSchema }).safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});

export type FixerReport = z.infer<typeof fixerReportSchema>;

const EXAMPLE = `\`\`\`json
{
  "fixed": [{ "finding": "F4", "summary": "What you changed, in a sentence.", "files": ["src/cache.ts"] }],
  "notFixed": [{ "finding": "F7", "reason": "Why not, in a sentence." }]
}
\`\`\``;

/** How the fixer reports on the user's own ask: fixes, findings it left, and beads issues it filed. */
export const ASK_REPORT_EXAMPLE = `\`\`\`json
{
  "fixed": [{ "finding": "F4", "summary": "What you changed, in a sentence.", "files": ["src/cache.ts"] }],
  "notFixed": [{ "finding": "F7", "reason": "Why not, in a sentence." }],
  "tickets": [{ "finding": "F2", "ticket": "proj-a1b" }]
}
\`\`\``;

/** The fixer conversation's first message: which findings, where the hand-off is, and how to report back. */
export function fixerPrompt(review: Review, findingIds: string[], handoffPath: string): string {
  const titles = findingIds.map((id) => {
    const finding = review.findings.find((each) => each.id === id);
    const reopened = finding?.fix?.state === "reopened" ? " (fixed before, reopened by the council's re-check)" : "";
    return `- ${id}: ${finding?.title ?? "?"}${reopened}`;
  });
  return [
    turnTitle(review, `Fix ${idsInTitle(findingIds)}`),
    `A Spectra Council review (${review.id}) of ${review.target} handed these findings to you to fix, most severe first:`,
    titles.join("\n"),
    `Read the hand-off first: ${handoffPath}. For each finding it has the evidence, how the council reached its conclusion (with any dissent), and the proposed fix with how to verify it. Treat the proposed fix as a starting point and check it against the code. Fix only these findings; leave the ones the hand-off lists under "Not to fix" alone.`,
    `You can't report to the review directly. When you are done, end your final message with this JSON block, one entry per finding above, in "fixed" or "notFixed":`,
    EXAMPLE,
  ].join("\n\n");
}

/** The fixer's report from its final message: the last ```json block that parses, or null when there is none. */
export const parseFixerReport = (text: string | null): FixerReport | null => lastJson(text, fixerReportSchema);
