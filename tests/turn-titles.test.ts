import { describe, expect, test } from "bun:test";
import { deliberationPrompt, groupingPrompt, idsInTitle, proposalPrompt, repairPrompt, reviewPrompt, turnTitle, verificationPrompt } from "../core/agent-turns.ts";
import { fixerPrompt } from "../core/fixer.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview } from "../core/review.ts";

/** Mirador titles a conversation with the first line of its first message, cut at 60 characters. */
const titleOf = (prompt: string) => prompt.split("\n", 1)[0]!;
const MIRADOR_TITLE_LENGTH = 60;

const review = newReview("44997a5e", { target: "/repo", profile: "code", depth: "standard", instructions: "", seats: [{ agent: "mock-claude", enabled: true }, { agent: "mock-codex", enabled: true }] }, "mock", 0);
const reviewer = review.reviewers[0]!;
const job = { review, reviewer, profile: PROFILES.code };

describe("conversation titles", () => {
  test("each turn's first line names the review, the task and the seat", () => {
    expect(titleOf(reviewPrompt(job))).toBe(`Spectra Council 44997a5e · Review · ${reviewer.label}`);
    expect(titleOf(groupingPrompt(job))).toBe(`Spectra Council 44997a5e · Grouping duplicates · ${reviewer.label}`);
    expect(titleOf(deliberationPrompt({ ...job, round: 2, rounds: 3 }))).toBe(`Spectra Council 44997a5e · Deliberation 2/3 · ${reviewer.label}`);
    expect(titleOf(proposalPrompt({ ...job, findingIds: ["F1", "F5"] }))).toBe(`Spectra Council 44997a5e · Proposals F1, F5 · ${reviewer.label}`);
    expect(titleOf(verificationPrompt({ ...job, findingIds: ["F2"], pass: 1 }))).toBe(`Spectra Council 44997a5e · Re-check F2 · ${reviewer.label}`);
    expect(titleOf(verificationPrompt({ ...job, findingIds: ["F2"], pass: 2 }))).toBe(`Spectra Council 44997a5e · Re-check 2 F2 · ${reviewer.label}`);
  });

  test("the fixer's conversation names the findings it fixes", () => {
    expect(titleOf(fixerPrompt(review, ["F1", "F6", "F2", "F4", "F9", "F10"], "/repo/h.md"))).toBe("Spectra Council 44997a5e · Fix F1, F6, F2 +3");
  });

  test("a retry keeps the original task's title", () => {
    expect(titleOf(repairPrompt(reviewPrompt(job), "no json here", "no JSON block"))).toBe(`Retry · Spectra Council 44997a5e · Review · ${reviewer.label}`);
  });

  test("the review and the task fit in Mirador's title; only the seat name may be cut", () => {
    const long = { ...reviewer, label: "Opus 5.5 (work-claude)" };
    const title = titleOf(deliberationPrompt({ ...job, reviewer: long, round: 3, rounds: 6 }));
    expect(title.indexOf(" · Opus")).toBeLessThan(MIRADOR_TITLE_LENGTH);
    expect(turnTitle(review, "Fix F1, F6, F2 +3").length).toBeLessThan(MIRADOR_TITLE_LENGTH);
  });

  test("finding ids are listed up to three, then counted", () => {
    expect(idsInTitle(["F1"])).toBe("F1");
    expect(idsInTitle(["F1", "F2", "F3"])).toBe("F1, F2, F3");
    expect(idsInTitle(["F1", "F2", "F3", "F4", "F5"])).toBe("F1, F2, F3 +2");
  });
});
