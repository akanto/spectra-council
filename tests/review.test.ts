import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { MAX_ACTIVITY } from "../core/model.ts";
import { newReview, reduce, ReviewError, setupOf } from "../core/review.ts";
import type { ArgumentInput, FindingInput } from "../core/schemas.ts";

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

  test("findings get ids in order and the review stays in the independent review when every reviewer is done", () => {
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
    expect(review.phase).toBe("independent-review");
    expect(review.endedAt).toBeNull();
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

const argument: ArgumentInput = { findingId: "F1", stance: "challenges", confidence: "medium", text: "Not so.", evidence: [] };

/** Two reviewers seated; r2 reported F1 and r1 reported F2; both finished, so the deliberation can start. */
function reviewed() {
  let review = reduce(fresh(), { type: "started", at: 10 });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 12, finding });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...finding, title: "Race" } });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" });
  return review;
}

const deliberating = (rounds = 3) => reduce(reviewed(), { type: "deliberation-started", at: 30, rounds });
const inRound = (round = 1) => reduce(deliberating(), { type: "round-started", at: 31, round });
const argue = (review: ReturnType<typeof fresh>, reviewerId: string, input: Partial<ArgumentInput> = {}, at = 40) =>
  reduce(review, { type: "argued", reviewerId, at, argument: { ...argument, ...input } });

describe("deliberation", () => {
  test("it starts only from the independent review, with every reviewer done", () => {
    expect(() => reduce(fresh(), { type: "deliberation-started", at: 1, rounds: 3 })).toThrow(ReviewError);
    let busy = reduce(fresh(), { type: "started", at: 10 });
    busy = reduce(busy, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    expect(() => reduce(busy, { type: "deliberation-started", at: 12, rounds: 3 })).toThrow("still reviewing");
    expect(() => reduce(reviewed(), { type: "deliberation-started", at: 30, rounds: 0 })).toThrow(ReviewError);
    expect(() => reduce(deliberating(), { type: "deliberation-started", at: 31, rounds: 3 })).toThrow(ReviewError);
  });

  test("it seeds the reporter's support in round 0 and moves completed reviewers to deliberating", () => {
    const review = deliberating();
    expect(review.phase).toBe("deliberation");
    expect([review.round, review.rounds]).toEqual([0, 3]);
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["deliberating", "deliberating"]);
    expect(review.findings[0]!.positions).toEqual([{ reviewerId: "r2", stance: "supports", confidence: "high", round: 0, at: 30 }]);
    expect(review.findings[1]!.positions).toMatchObject([{ reviewerId: "r1", stance: "supports", round: 0 }]);
  });

  test("a failed reviewer stays failed and doesn't take part", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" });
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 20, outcome: "failed", problem: "crashed" });
    review = reduce(review, { type: "deliberation-started", at: 30, rounds: 2 });
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["deliberating", "failed"]);
    review = reduce(review, { type: "round-started", at: 31, round: 1 });
    expect(review.reviewers[1]!.status).toBe("failed");
    expect(argue(review, "r2")).toBe(review);
  });

  test("rounds come in order and within the count", () => {
    const review = deliberating(2);
    expect(() => reduce(review, { type: "round-started", at: 31, round: 2 })).toThrow("can't follow");
    expect(() => reduce(fresh(), { type: "round-started", at: 31, round: 1 })).toThrow(ReviewError);
    let next = reduce(review, { type: "round-started", at: 31, round: 1 });
    expect(next.round).toBe(1);
    next = reduce(next, { type: "round-started", at: 32, round: 2 });
    expect(next.round).toBe(2);
    expect(() => reduce(next, { type: "round-started", at: 33, round: 3 })).toThrow(ReviewError);
    expect(() => reduce(next, { type: "round-started", at: 33, round: 2 })).toThrow(ReviewError);
  });

  test("arguments get ids A1.. and carry the round, and need a round under way", () => {
    expect(() => argue(deliberating(), "r1")).toThrow("deliberation round");
    const done = reviewed(); // its reviewers are finished, so a stray argument is ignored like any late runner event
    expect(argue(done, "r1")).toBe(done);
    let review = argue(inRound(), "r1", {}, 40);
    review = argue(review, "r2", { findingId: "F2", stance: "supports", replyTo: "A1" }, 41);
    expect(review.arguments.map((it) => [it.id, it.reviewerId, it.findingId, it.round, it.at])).toEqual([
      ["A1", "r1", "F1", 1, 40],
      ["A2", "r2", "F2", 1, 41],
    ]);
    expect(review.arguments[1]!.replyTo).toBe("A1");
    expect(review.arguments[0]).not.toHaveProperty("replyTo");
    expect(review.reviewers[0]!.activity.at(-1)).toMatchObject({ kind: "argument" });
  });

  test("unknown findings and replies are refused", () => {
    expect(() => argue(inRound(), "r1", { findingId: "F9" })).toThrow("no finding F9");
    expect(() => argue(inRound(), "r1", { replyTo: "A7" })).toThrow("no argument A7");
  });

  test("a reviewer who isn't in the deliberation can't argue", () => {
    expect(() => argue(inRound(), "r3")).toThrow("No reviewer r3");
    const review = reduce(inRound(), { type: "reviewer-finished", reviewerId: "r1", at: 35, outcome: "failed" });
    expect(review.reviewers[0]!.status).toBe("failed");
    expect(argue(review, "r1")).toBe(review);
  });

  test("the latest stance of a reviewer on a finding replaces its old one", () => {
    let review = argue(inRound(), "r1", { stance: "challenges" }, 40);
    review = argue(review, "r2", { stance: "supports" }, 41);
    review = argue(review, "r1", { stance: "uncertain", confidence: "low" }, 42);
    const positions = review.findings[0]!.positions;
    expect(positions).toHaveLength(2);
    expect(positions.find((it) => it.reviewerId === "r1")).toMatchObject({ stance: "uncertain", confidence: "low", round: 1, at: 42 });
    expect(positions.find((it) => it.reviewerId === "r2")).toMatchObject({ stance: "supports", round: 1 });
    expect(review.arguments).toHaveLength(3);
  });

  test("a finding is resolved only in the synthesis", () => {
    const resolve = { type: "finding-resolved" as const, at: 50, findingId: "F1", status: "disputed" as const, rationale: "1 of 2 back it.", dissenters: ["r1"] };
    expect(() => reduce(inRound(), resolve)).toThrow(ReviewError);
    let review = reduce(inRound(), { type: "synthesis-started", at: 49 });
    expect(review.phase).toBe("synthesis");
    expect(() => reduce(review, { ...resolve, findingId: "F9" })).toThrow("no finding F9");
    expect(() => reduce(fresh(), { type: "synthesis-started", at: 1 })).toThrow(ReviewError);
    review = reduce(review, resolve);
    expect(review.findings[0]).toMatchObject({ status: "disputed", resolution: { status: "disputed", rationale: "1 of 2 back it.", dissenters: ["r1"], at: 50 } });
    expect(review.findings[1]!.status).toBe("reported");
  });

  test("concluding sets the verdict, completes the review and its deliberating reviewers", () => {
    let review = reduce(inRound(), { type: "synthesis-started", at: 49 });
    review = reduce(review, { type: "concluded", at: 60, summary: "All good." });
    expect(review).toMatchObject({ phase: "complete", endedAt: 60, verdict: { summary: "All good.", at: 60 } });
    expect(review.reviewers.slice(0, 2).map((reviewer) => [reviewer.status, reviewer.endedAt])).toEqual([["completed", 60], ["completed", 60]]);
  });

  test("a review with nothing to deliberate concludes straight from the independent review", () => {
    const review = reduce(reviewed(), { type: "concluded", at: 25, summary: "Done." });
    expect(review.phase).toBe("complete");
    expect(review.verdict?.summary).toBe("Done.");
  });

  test("it can't conclude before setup, while reviewers review, or twice", () => {
    expect(() => reduce(fresh(), { type: "concluded", at: 1, summary: "x" })).toThrow(ReviewError);
    let busy = reduce(fresh(), { type: "started", at: 10 });
    busy = reduce(busy, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    expect(() => reduce(busy, { type: "concluded", at: 12, summary: "x" })).toThrow("still reviewing");
    const done = reduce(reviewed(), { type: "concluded", at: 25, summary: "x" });
    expect(() => reduce(done, { type: "concluded", at: 26, summary: "y" })).toThrow(ReviewError);
  });

  test("a stop during the deliberation stops the deliberating reviewers, and later events change nothing", () => {
    const review = reduce(inRound(), { type: "stopped", at: 45 });
    expect(review.phase).toBe("stopped");
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped"]);
    expect(argue(review, "r1")).toBe(review);
    expect(reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 46, outcome: "completed" })).toBe(review);
    expect(reduce(review, { type: "stopped", at: 47 })).toBe(review);
  });

  test("seq goes up by one per event that changes the review", () => {
    const base = inRound();
    expect(argue(base, "r1").seq).toBe(base.seq + 1);
    expect(reduce(base, { type: "synthesis-started", at: 1 }).seq).toBe(base.seq + 1);
    const stopped = reduce(base, { type: "stopped", at: 1 });
    expect(reduce(stopped, { type: "stopped", at: 2 }).seq).toBe(stopped.seq);
  });
});
