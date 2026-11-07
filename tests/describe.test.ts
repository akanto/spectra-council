import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { possibleDuplicates, recheckLine } from "../core/describe.ts";
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
