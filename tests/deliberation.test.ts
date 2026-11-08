import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { DISSENT_REASON_MAX, firstSentence, settle, verdictSummary } from "../core/deliberation.ts";
import { REVIEW_FORMAT, type Finding, type Review } from "../core/model.ts";
import { newReview, reduce, upgradeReview } from "../core/review.ts";
import type { ArgumentInput, FindingInput, Stance } from "../core/schemas.ts";

const finding: FindingInput = { title: "Off by one", summary: "Drops the last element.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 3 }] };

/** Three reviewers (r1 Claude, r2 Codex, r3 Gemini) finished their review; r1 reported F1; round 1 is open. */
function council(severity: FindingInput["severity"] = "medium"): Review {
  const seats = ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent, index) => ({ agent, enabled: index < 3 }));
  let review = reduce(newReview("rev1", { target: "/repo", profile: "code", depth: "standard", instructions: "", seats }, "mock", 0), { type: "started", at: 1 });
  for (const reviewerId of ["r1", "r2", "r3"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 3, finding: { ...finding, severity } });
  for (const reviewerId of ["r1", "r2", "r3"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
  review = reduce(review, { type: "deliberation-started", at: 5, rounds: 3 });
  return reduce(review, { type: "round-started", at: 6, round: 1 });
}

const argue = (review: Review, reviewerId: string, stance: Stance, round = review.round, text = "Because."): Review => {
  while (review.round < round) review = reduce(review, { type: "round-started", at: 7, round: review.round + 1 });
  const argument: ArgumentInput = { findingId: "F1", stance, confidence: "medium", text, evidence: [] };
  return reduce(review, { type: "argued", reviewerId, at: 8, argument });
};

const settled = (review: Review) => settle(review, review.findings[0]!);

describe("settle", () => {
  test("a finding nobody challenged, backed by everyone, is agreed", () => {
    let review = council();
    for (const reviewerId of ["r2", "r3"]) review = argue(review, reviewerId, "supports");
    expect(settled(review)).toEqual({ status: "agreed", rationale: "All 3 reviewers back it.", dissenters: [] });
  });

  test("silence is not support: a reviewer who never argued leaves the finding confirmed", () => {
    const review = argue(council(), "r2", "supports");
    expect(settled(review)).toMatchObject({ status: "confirmed", rationale: "2 of 3 back it." });
  });

  test("someone uncertain makes it confirmed, not agreed", () => {
    let review = argue(council(), "r2", "supports");
    review = argue(review, "r3", "uncertain");
    expect(settled(review)).toEqual({ status: "confirmed", rationale: "2 of 3 back it; Gemini couldn't tell.", dissenters: [] });
  });

  test("one challenger among three supporters is disputed, with that dissenter", () => {
    const seats = ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: true }));
    let review = reduce(newReview("rev1", { target: "/repo", profile: "code", depth: "standard", instructions: "", seats }, "mock", 0), { type: "started", at: 1 });
    for (const reviewerId of ["r1", "r2", "r3", "r4"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
    review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 3, finding });
    for (const reviewerId of ["r1", "r2", "r3", "r4"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
    review = reduce(review, { type: "deliberation-started", at: 5, rounds: 3 });
    review = reduce(review, { type: "round-started", at: 6, round: 1 });
    for (const reviewerId of ["r2", "r3"]) review = argue(review, reviewerId, "supports");
    review = argue(review, "r4", "challenges");
    expect(settled(review)).toEqual({
      status: "disputed",
      rationale: "3 of 4 back it; Qwen's challenge stands.",
      dissenters: ["r4"],
      dissent: [{ reviewerId: "r4", reason: "Because.", argumentId: "A3" }],
    });
  });

  test("two challenges are listed together", () => {
    let review = argue(council(), "r2", "challenges");
    review = argue(review, "r3", "challenges");
    expect(settled(review)).toEqual({
      status: "disputed",
      rationale: "1 of 3 back it; Codex and Gemini's challenges stand.",
      dissenters: ["r2", "r3"],
      dissent: [
        { reviewerId: "r2", reason: "Because.", argumentId: "A1" },
        { reviewerId: "r3", reason: "Because.", argumentId: "A2" },
      ],
    });
  });

  test("a dissent's reason is the first sentence of the dissenter's latest challenge", () => {
    let review = argue(council(), "r2", "challenges", 1, "An older objection.");
    review = argue(review, "r2", "challenges", 2, "The unchecked path is guarded by validateInput() at api.ts:42. It never sees raw input, e.g. from the CLI.");
    const settlement = settled(review);
    expect(settlement.dissent).toEqual([{ reviewerId: "r2", reason: "The unchecked path is guarded by validateInput() at api.ts:42.", argumentId: "A2" }]);
    expect(settlement.rationale).toBe("1 of 3 back it; Codex's challenge stands.");
  });

  test("the resolution keeps the dissent", () => {
    let review = argue(council(), "r2", "challenges", 1, "Not reachable");
    review = reduce(review, { type: "synthesis-started", at: 9 });
    review = reduce(review, { type: "finding-resolved", at: 10, findingId: "F1", ...settled(review) });
    expect(review.findings[0]!.resolution).toMatchObject({ rationale: "1 of 3 back it; Codex's challenge stands.", dissent: [{ reviewerId: "r2", reason: "Not reachable", argumentId: "A1" }] });
  });

  test("a challenger who came round leaves it confirmed, and says the challenge was answered", () => {
    let review = argue(council(), "r2", "challenges", 1);
    review = argue(review, "r3", "supports", 1);
    review = argue(review, "r2", "supports", 2);
    expect(settled(review)).toEqual({ status: "confirmed", rationale: "3 of 3 back it; the challenge was answered.", dissenters: [] });
  });

  test("a reporter who conceded after a challenge withdrew it, naming the challenger", () => {
    let review = argue(council(), "r2", "challenges", 1);
    review = argue(review, "r1", "challenges", 2);
    expect(settled(review)).toEqual({ status: "withdrawn", rationale: "Claude withdrew it after Codex's challenge.", dissenters: [] });
  });

  test("a reporter who conceded with no challenger just withdrew it", () => {
    const review = argue(council(), "r1", "uncertain");
    expect(settled(review)).toEqual({ status: "withdrawn", rationale: "Claude withdrew it.", dissenters: [] });
  });

  test("a failed reviewer doesn't count among the participants", () => {
    let review = council();
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r3", at: 7, outcome: "failed" });
    review = argue(review, "r2", "supports");
    expect(settled(review)).toEqual({ status: "agreed", rationale: "All 2 reviewers back it.", dissenters: [] });
  });
});

describe("firstSentence", () => {
  test("stops at the first sentence end, not at a dot inside a path or an abbreviation", () => {
    expect(firstSentence("The check is already done, see core/api.ts:42. Then more.")).toBe("The check is already done, see core/api.ts:42.");
    expect(firstSentence("It is guarded, e.g. by the caller, so it is fine! Second.")).toBe("It is guarded, e.g. by the caller, so it is fine!");
    expect(firstSentence("  No end\n  at all  ")).toBe("No end at all");
  });

  test("a short lead-in takes the next sentence along", () => {
    expect(firstSentence("Not a bug. The caller validates input before parse(). More detail.")).toBe("Not a bug. The caller validates input before parse().");
    expect(firstSentence("I disagree. The lock is held by the caller.")).toBe("I disagree. The lock is held by the caller.");
  });

  test("abbreviations, initials and quoted sentence ends", () => {
    expect(firstSentence("It is guarded, e.g. React escapes it for us. Second sentence.")).toBe("It is guarded, e.g. React escapes it for us.");
    expect(firstSentence("This breaks the U.S. API contract in two places. Second.")).toBe("This breaks the U.S. API contract in two places.");
    expect(firstSentence('The comment in the handler says "never." Then more follows here.')).toBe('The comment in the handler says "never."');
  });

  test("a hard cut splits neither a surrogate pair nor a finding id", () => {
    const emoji = firstSentence(`${"x".repeat(198)}😀 tail`);
    expect(emoji.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(emoji)).toBe(false);
    const id = firstSentence(`a ${"path/".repeat(39)}F12 tail`);
    expect(id).not.toMatch(/F1…$/);
  });

  test("cuts a long sentence at a word, with an ellipsis, within the limit", () => {
    const long = `${"word ".repeat(80)}end.`;
    const cut = firstSentence(long);
    expect(cut.length).toBeLessThanOrEqual(DISSENT_REASON_MAX);
    expect(cut.endsWith("word…")).toBe(true);
  });
});

describe("verdictSummary", () => {
  const resolve = (review: Review, status: Exclude<Finding["status"], "reported">): Review => {
    let next = reduce(review, { type: "synthesis-started", at: 9 });
    return reduce(next, { type: "finding-resolved", at: 10, findingId: "F1", status, rationale: "r", dissenters: [] });
  };

  test("no findings", () => {
    const review = reduce(newReview("r", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: defaultSeats() }, "mock", 0), { type: "started", at: 1 });
    expect(verdictSummary(review)).toBe("The council found nothing to report.");
  });

  test("findings never deliberated", () => {
    expect(verdictSummary(council())).toBe("1 finding, not deliberated: fewer than two reviewers finished their review.");
  });

  test("a serious confirmed finding counts", () => {
    expect(verdictSummary(resolve(council("high"), "confirmed"))).toBe("1 finding: 1 confirmed. 1 serious finding stands.");
  });

  test("a disputed or withdrawn serious finding doesn't count as standing; a disputed one is named", () => {
    expect(verdictSummary(resolve(council("critical"), "disputed"))).toBe("1 finding: 1 disputed. No serious finding is agreed or confirmed. 1 serious finding is disputed.");
    expect(verdictSummary(resolve(council("critical"), "withdrawn"))).toBe("1 finding: 1 withdrawn. No serious finding stands.");
  });

  test("a reviewer that failed is named", () => {
    let review = reduce(newReview("r", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: defaultSeats() }, "mock", 0), { type: "started", at: 1 });
    review = reduce(review, { type: "reviewer-started", reviewerId: "r2", at: 2 });
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 3, outcome: "failed", problem: "Its conversation failed" });
    expect(verdictSummary(review)).toBe("The council found nothing to report.");
    review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 2 });
    review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 4, finding });
    expect(verdictSummary(review)).toBe("1 finding, not deliberated: fewer than two reviewers finished their review. Codex failed and took no part.");
  });

  test("a medium agreed finding is not serious", () => {
    expect(verdictSummary(resolve(council("medium"), "agreed"))).toBe("1 finding: 1 agreed. No serious finding stands.");
  });

  test("mixed statuses, in a fixed order", () => {
    const review = council("critical");
    const base: Review = {
      ...review,
      findings: ["agreed", "withdrawn", "confirmed", "disputed", "confirmed"].map((status, index) => ({
        ...review.findings[0]!,
        id: `F${index + 1}`,
        status: status as Finding["status"],
        severity: index === 0 || index === 2 ? "critical" : "low",
      })),
    };
    expect(verdictSummary(base)).toBe("5 findings: 1 agreed, 2 confirmed, 1 disputed, 1 withdrawn. 2 serious findings stand.");
  });
});

describe("upgradeReview", () => {
  test("a format-1 review gets the deliberation fields", () => {
    const current = council();
    const { arguments: _a, round: _r, rounds: _rs, verdict: _v, ...rest } = current;
    const stored = { ...rest, format: 1, findings: current.findings.map(({ positions: _p, resolution: _res, ...old }) => old) } as unknown as Review;
    const upgraded = upgradeReview(stored);
    expect(upgraded.format).toBe(REVIEW_FORMAT);
    expect(upgraded).toMatchObject({ arguments: [], round: 0, rounds: 0, verdict: null, id: "rev1", phase: "deliberation" });
    expect(upgraded.findings[0]).toMatchObject({ id: "F1", positions: [], resolution: null, status: "reported" });
  });

  test("a format-2 review is returned as is", () => {
    const review = council();
    expect(upgradeReview(review)).toBe(review);
  });
});
