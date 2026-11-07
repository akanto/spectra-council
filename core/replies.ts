/** Reading what an agent in another conversation reports in its final message: the last ```json block that fits. */
import type { z } from "zod";
import { problemsOf } from "./schemas.ts";

interface Block {
  tag: string;
  body: string;
}

/**
 * The fenced blocks of a Markdown text, paired line by line as CommonMark does: an opening line is three or more
 * backticks or tildes with any info string after them (its first word is the tag), and the block ends at the next line
 * that is only a fence of the same character, at least as long. A fence inside a line (a quote in a JSON string, say)
 * doesn't count, and JSON strings can't hold a raw line break, so a JSON block can't end early.
 */
function fencedBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: { fence: string; tag: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      const closer = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closer && closer[1]![0] === open.fence[0] && closer[1]!.length >= open.fence.length) {
        blocks.push({ tag: open.tag, body: open.lines.join("\n") });
        open = null;
      } else open.lines.push(line);
      continue;
    }
    const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opener) continue;
    const [, fence, info] = opener as unknown as [string, string, string];
    // A backtick fence's info string can't hold a backtick: such a line is inline code, not a fence.
    if (fence[0] === "`" && info.includes("`")) continue;
    open = { fence, tag: (info.trim().split(/\s+/)[0] ?? "").toLowerCase(), lines: [] };
  }
  // A reply cut off before its closing fence still counts.
  if (open) blocks.push({ tag: open.tag, body: open.lines.join("\n") });
  return blocks;
}

/** The last fenced JSON block (tagged json, or untagged) in `text` that parses and fits `schema`; null when none does. */
export function lastJson<T extends z.ZodType>(text: string | null, schema: T): z.infer<T> | null {
  if (!text) return null;
  const candidates = fencedBlocks(text)
    .filter((block) => block.tag === "json" || block.tag === "")
    .reverse();
  for (const { body } of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(body));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: try the block before it.
    }
  }
  return null;
}

/** One line on why `lastJson` found nothing in `text`: judged by the last fenced JSON block, the one it tries first. */
export function jsonProblem(text: string | null, schema: z.ZodType): string {
  if (!text || !text.trim()) return "the reply had no text";
  const last = fencedBlocks(text)
    .filter((block) => block.tag === "json" || block.tag === "")
    .at(-1);
  if (!last) return "no fenced ```json block";
  let value: unknown;
  try {
    value = JSON.parse(last.body);
  } catch (error) {
    return `the last JSON block doesn't parse: ${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return "the last JSON block fits, but no block was accepted";
  return `the last JSON block doesn't fit the shape: ${problemsOf(parsed.error)}`;
}
