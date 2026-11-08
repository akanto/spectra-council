/**
 * What the narrator says; the edit puts each line at a moment of the footage. `bun video/lib/narrate.ts` speaks them,
 * in the voice of NeoManuscript's video. Written to be said: contractions, short sentences, and commas where a person
 * would breathe.
 */
export const VOICE = "af_heart";
export const SPEED = 1;

export const LINES = {
  intro: "Ask one AI to review your code, and you get one opinion. Spectra Council seats several, and has them argue it out.",
  ask: "Here's a small shop's API. Ask Mirador's agent for a council review, with Claude, Codex, Gemini and Qwen, each on its own model.",
  independent: "Each reviewer works alone, without seeing the others. And every finding comes with evidence: a file, a line, a quote.",
  twice: "Two of them found the same SQL injection on their own. That counts.",
  deliberate: "Then the findings go on the table. The reviewers back them, or challenge them, and every argument has to point at the code.",
  race: "One doubts the race in checkout. Another shows the await that splits the check from the write, and the doubter comes round.",
  verdict: "Nothing is outvoted. A challenge that still stands stays on the record, as the finding's minority report.",
  rule: "You rule on each finding, and hand the accepted ones to your agent, which fixes them for real.",
  recheck: "Then the council checks the fixes. All four hold up, verified by the reviewers who found them.",
  end: "Spectra Council. A hearing, not a vote. Free and open source, for Mirador.",
} as const;

export type LineName = keyof typeof LINES;
