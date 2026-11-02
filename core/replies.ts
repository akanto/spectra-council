/** Reading what an agent in another conversation reports in its final message: the last ```json block that fits. */
import type { z } from "zod";

/** The last fenced JSON block in `text` that parses and fits `schema`; null when none does. */
export function lastJson<T extends z.ZodType>(text: string | null, schema: T): z.infer<T> | null {
  if (!text) return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!).reverse();
  for (const block of blocks) {
    try {
      const parsed = schema.safeParse(JSON.parse(block));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: try the block before it.
    }
  }
  return null;
}
