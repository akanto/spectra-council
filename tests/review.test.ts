import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { MAX_ACTIVITY } from "../core/model.ts";
import { newReview, reduce, ReviewError, setupOf } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: defaultSeats() };
const fresh = () => newReview("rev1", setup, "mock", 0);

const finding: FindingInput = {
  title: "Off by one",
  summary: "The loop drops the last element.",
  severity: "medium",
  confidence: "high",
  category: "correctness",
  evidence: [{ path: "src/a.ts", line: 3 }],
};

describe("reduce", () => {
  test("a new review seats four agents, two taking part", () => {
    const review = fresh();
    expect(review.reviewers.map((reviewer) => [reviewer.id, reviewer.label, reviewer.enabled])).toEqual([
      ["r1", "Claude", true],
      ["r2", "Codex", true],
      ["r3", "Gemini", false],
      ["r4", "Qwen", false],
    ]);
    expect(setupOf(review)).toEqual(setup);
  });

  test("configure changes the setup, and only before the start", () => {
    const seats = defaultSeats().map((seat) => ({ ...seat, enabled: true }));
    const configured = reduce(fresh(), { type: "configured", patch: { profile: "security", seats } });
    expect(configured.profile).toBe("security");
    expect(configured.reviewers.every((reviewer) => reviewer.enabled)).toBe(true);
    expect(configured.seq).toBe(1);
    const started = reduce(configured, { type: "started", at: 1 });
    expect(() => reduce(started, { type: "configured", patch: { depth: "deep" } })).toThrow(ReviewError);
  });

  test("a review with no reviewer seated can't start", () => {
    const empty = reduce(fresh(), { type: "configured", patch: { seats: defaultSeats().map((seat) => ({ ...seat, enabled: false })) } });
    expect(() => reduce(empty, { type: "started", at: 1 })).toThrow("Seat at least one reviewer");
  });

  test("findings get ids in order and the review completes when every reviewer is done", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
    review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 12, finding });
    review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...finding, title: "Race" } });
    expect(review.findings.map((it) => [it.id, it.reviewerId, it.status])).toEqual([
      ["F1", "r2", "reported"],
      ["F2", "r1", "reported"],
    ]);
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" });
    expect(review.phase).toBe("independent-review");
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 21, outcome: "failed", problem: "crashed" });
    expect(review.phase).toBe("complete");
    expect(review.endedAt).toBe(21);
    expect(review.reviewers[1]).toMatchObject({ status: "failed", problem: "crashed" });
  });

  test("a stop ends the active reviewers, and later runner events change nothing", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    review = reduce(review, { type: "stopped", at: 12 });
    expect(review.phase).toBe("stopped");
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped"]);
    const late = reduce(review, { type: "activity", reviewerId: "r1", at: 13, kind: "read", text: "Reading x" });
    expect(late).toBe(review);
  });

  test("activity is capped, the count is not, and notes keep the current step", () => {
    let review = reduce(fresh(), { type: "started", at: 0 });
    review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 0 });
    for (let i = 0; i < MAX_ACTIVITY + 10; i++) review = reduce(review, { type: "activity", reviewerId: "r1", at: i, kind: "read", text: `Reading ${i}`, path: `f${i}` });
    review = reduce(review, { type: "activity", reviewerId: "r1", at: 999, kind: "note", text: "Hmm" });
    const reviewer = review.reviewers[0]!;
    expect(reviewer.activity).toHaveLength(MAX_ACTIVITY);
    expect(reviewer.activityCount).toBe(MAX_ACTIVITY + 11);
    expect(reviewer.current).toBe(`Reading ${MAX_ACTIVITY + 9}`);
  });

  test("events for a reviewer not taking part are refused", () => {
    const review = reduce(fresh(), { type: "started", at: 0 });
    expect(() => reduce(review, { type: "reviewer-started", reviewerId: "r3", at: 1 })).toThrow("No reviewer r3");
  });
});
