import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { finishedPrompt, fixerFinishedPrompt, possibleDuplicates, recheckLine } from "../core/describe.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";

const finding = (title: string): FindingInput => ({ title, summary: "s", severity: "high", confidence: "high", category: "c", evidence: [{ path: "a.ts", line: 1 }] });

function reported(...titles: string[]): Review {
  let review = reduce(newReview("r", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: defaultSeats() }, "mock", 0), { type: "started", at: 1 });
  review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 2 });
  review = reduce(review, { type: "reviewer-started", reviewerId: "r2", at: 2 });
  titles.forEach((title, index) => (review = reduce(review, { type: "finding-reported", reviewerId: index % 2 ? "r2" : "r1", at: 3, finding: finding(title) })));
  return review;
}

describe("possibleDuplicates", () => {
  test("the same title, whatever its case and punctuation, is a possible duplicate", () => {
    const review = reported("Schema evolution not planned", "Off by one", "schema evolution: not planned!");
    expect(possibleDuplicates(review, review.findings[0]!).map(({ id }) => id)).toEqual(["F3"]);
    expect(possibleDuplicates(review, review.findings[1]!)).toEqual([]);
  });

  test("a finding an argument about it names is a possible duplicate", () => {
    let review = reported("Cache never expires", "Stale reads");
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
    review = reduce(review, { type: "deliberation-started", at: 5, rounds: 2 });
    review = reduce(review, { type: "round-started", at: 6, round: 1 });
    review = reduce(review, { type: "argued", reviewerId: "r2", at: 7, argument: { findingId: "F1", stance: "supports", confidence: "high", text: "I found the same in F2.", evidence: [] } });
    expect(possibleDuplicates(review, review.findings[0]!).map(({ id }) => id)).toEqual(["F2"]);
    expect(possibleDuplicates(review, review.findings[1]!).map(({ id }) => id)).toEqual(["F1"]);
  });

  test("naming a finding without calling it the same doesn't make it a duplicate", () => {
    let review = reported("Cache never expires", "Stale reads");
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
    review = reduce(review, { type: "deliberation-started", at: 5, rounds: 2 });
    review = reduce(review, { type: "round-started", at: 6, round: 1 });
    review = reduce(review, { type: "argued", reviewerId: "r2", at: 7, argument: { findingId: "F1", stance: "supports", confidence: "high", text: "Unlike F2, this one compounds over time.", evidence: [] } });
    expect(possibleDuplicates(review, review.findings[0]!)).toEqual([]);
  });
});

describe("recheckLine", () => {
  test("nothing before a re-check", () => {
    expect(recheckLine(reported("A"))).toBeNull();
  });
});

describe("fixerFinishedPrompt", () => {
  test("says what the fixer fixed and what it didn't, with the reasons, and asks for no council tool", () => {
    const text = fixerFinishedPrompt(reported("A"), "codex", { fixed: ["F1", "F3"], notFixed: [{ finding: "F7", reason: "Too risky" }], tickets: [], problem: null });
    expect(text).toContain("Spectra Council review r");
    expect(text).toContain('the fixer conversation on the "codex" profile is back');
    expect(text).toContain("It fixed F1, F3.");
    expect(text).toContain("It didn't fix F7: Too risky.");
    expect(text).toContain("Tell the user in one or two lines what came of it, without calling any council tool.");
  });

  test("names the beads issues the fixer filed", () => {
    const text = fixerFinishedPrompt(reported("A"), "codex", { fixed: ["F1"], notFixed: [], tickets: [{ finding: "F2", ticket: "proj-a1b" }, { finding: "F5", ticket: "proj-c3d" }], problem: null });
    expect(text).toContain("It fixed F1. It filed proj-a1b for F2; proj-c3d for F5.");
  });

  test("says nothing about lists that are empty and passes a problem's words on", () => {
    const text = fixerFinishedPrompt(reported("A"), "codex", { fixed: [], notFixed: [], tickets: [], problem: "codex's conversation failed before it reported." });
    expect(text).not.toContain("It fixed");
    expect(text).not.toContain("It didn't fix");
    expect(text).not.toContain("It filed");
    expect(text).toContain("codex's conversation failed before it reported.");
  });

  test("a reason's own full stop doesn't double up", () => {
    const text = fixerFinishedPrompt(reported("A"), "codex", { fixed: [], notFixed: [{ finding: "F2", reason: "codex didn't report on it." }], tickets: [], problem: null });
    expect(text).toContain("It didn't fix F2: codex didn't report on it. Tell the user");
  });
});

describe("finishedPrompt", () => {
  /** A review whose reviewers ended as given and that concluded without a deliberation, as it does with fewer than two. */
  function concludedAfter(outcomes: { r1: "completed" | "failed"; r2: "completed" | "failed" }, ...titles: string[]) {
    let review = reported(...titles);
    for (const [reviewerId, outcome] of Object.entries(outcomes)) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome, problem: outcome === "failed" ? "It broke." : undefined });
    return reduce(review, { type: "concluded", at: 5, summary: "Verdict." });
  }

  test("counts the findings of a review that ended without a deliberation, and says which reviewers failed", () => {
    const text = finishedPrompt(concludedAfter({ r1: "completed", r2: "failed" }, "Off by one"));
    expect(text).toContain("Spectra Council review r is finished (1 finding, 1 serious; 1 of its 2 reviewers failed).");
    expect(text).toContain("Tell the user in one or two lines what came of it, without calling any council tool.");
  });

  test("says a review whose reviewers all failed found nothing because they failed", () => {
    expect(finishedPrompt(concludedAfter({ r1: "failed", r2: "failed" }))).toContain("is finished (0 findings; 2 of its 2 reviewers failed).");
  });
});
