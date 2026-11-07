import { describe, expect, test } from "bun:test";
import { ReviewSession } from "../core/engine.ts";
import { isResumable, isStanding, type Review } from "../core/model.ts";
import { MockRunner } from "../core/mock-runner.ts";
import { newReview, reduce, ReviewError, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].map((agent) => ({ agent, enabled: true })) };
const fresh = () => newReview("rev1", setup, "mock", 0);

const finding = (title: string, path = "src/a.ts"): FindingInput => ({ title, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path, line: 3 }] });

const play = (review: Review, events: ReviewEvent[]) => events.reduce(reduce, review);
const started = () => play(fresh(), [{ type: "started", at: 1 }, ...["r1", "r2", "r3"].map((reviewerId): ReviewEvent => ({ type: "reviewer-started", reviewerId, at: 2 }))]);
const finish = (reviewerId: string, at = 20): ReviewEvent => ({ type: "reviewer-finished", reviewerId, at, outcome: "completed" });
const argue = (reviewerId: string, findingId: string, stance: "supports" | "challenges", at: number): ReviewEvent => ({
  type: "argued",
  reviewerId,
  at,
  argument: { findingId, stance, confidence: "high", text: `${reviewerId} ${stance} ${findingId}`, evidence: [] },
});

/** Everyone reviewed: F1 by r1 (also reported by r2, merged in) and F3 by r3; deliberating with 2 rounds. */
function deliberating(): Review {
  return play(started(), [
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Alpha leak") },
    { type: "finding-reported", reviewerId: "r2", at: 4, finding: finding("Alpha leak") },
    { type: "finding-reported", reviewerId: "r3", at: 5, finding: finding("Gamma crash", "src/c.ts") },
    ...["r1", "r2", "r3"].map((reviewerId) => finish(reviewerId)),
    { type: "findings-merged", at: 21, into: "F1", merged: ["F2"] },
    { type: "deliberation-started", at: 22, rounds: 2 },
  ]);
}

describe("interrupted", () => {
  test("records the phase it was in and is resumable", () => {
    const review = reduce(started(), { type: "interrupted", at: 10 });
    expect(review).toMatchObject({ phase: "interrupted", interruptedPhase: "independent-review", endedAt: 10 });
    expect(isResumable(review)).toBe(true);
    const round = reduce(play(deliberating(), [{ type: "round-started", at: 23, round: 1 }]), { type: "interrupted", at: 30 });
    expect(round.interruptedPhase).toBe("deliberation");
    const synthesis = reduce(play(deliberating(), [{ type: "round-started", at: 23, round: 1 }, { type: "round-started", at: 24, round: 2 }, { type: "synthesis-started", at: 25 }]), { type: "interrupted", at: 30 });
    expect(synthesis.interruptedPhase).toBe("synthesis");
  });

  test("a stop is not resumable", () => {
    const stopped = reduce(started(), { type: "stopped", at: 10 });
    expect(stopped.interruptedPhase).toBeNull();
    expect(isResumable(stopped)).toBe(false);
  });

  test("an interrupted verification just completes, and isn't resumable", async () => {
    const clock = new FakeClock();
    const base = newReview("rev4", { ...setup, seats: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: true })) }, "mock", 0);
    const done = new ReviewSession(base, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} }).run();
    await clock.runAll();
    let review = await done;
    const ids = review.findings.filter(isStanding).map((each) => each.id);
    review = play(review, [
      ...ids.map((findingId): ReviewEvent => ({ type: "ruled", at: 5_000_000, findingId, decision: "accepted", note: "" })),
      { type: "handoff-written", at: 5_000_001, path: "/tmp/h.md", findingIds: ids },
      { type: "fix-requested", at: 5_000_002, findingIds: ids },
      ...ids.map((findingId): ReviewEvent => ({ type: "fix-reported", at: 5_000_003, findingId, summary: "Fixed.", files: [] })),
      { type: "verification-started", at: 5_000_004, findingIds: ids, reviewerIds: ["r1"] },
    ]);
    expect(review.phase).toBe("verification");
    const after = reduce(review, { type: "interrupted", at: 5_000_005 });
    expect(after.phase).toBe("complete");
    expect(isResumable(after)).toBe(false);
    expect(() => reduce(after, { type: "resumed", at: 5_000_006 })).toThrow(ReviewError);
  });
});

describe("resumed", () => {
  test("in the independent review, cut-short reviewers wait again without their findings; finished ones keep theirs", () => {
    const review = play(started(), [
      { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Alpha leak") },
      { type: "finding-reported", reviewerId: "r2", at: 4, finding: finding("Beta race", "src/b.ts") },
      finish("r1"),
      { type: "interrupted", at: 30 },
    ]);
    expect(review.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "stopped", "stopped"]);
    const resumed = reduce(review, { type: "resumed", at: 40 });
    expect(resumed).toMatchObject({ phase: "independent-review", endedAt: null, interruptedPhase: null });
    expect(resumed.reviewers.map((reviewer) => reviewer.status)).toEqual(["completed", "waiting", "waiting"]);
    expect(resumed.reviewers[1]).toMatchObject({ startedAt: null, endedAt: null });
    expect(resumed.reviewers[1]!.activity.at(-1)!.text).toContain("Resuming");
    expect(resumed.findings.map((each) => [each.id, each.reviewerId])).toEqual([["F1", "r1"]]);
    // The dropped finding's id is not given out again.
    expect(resumed.findingsIssued).toBe(2);
  });

  test("in a deliberation round, that round's arguments go, the round steps back and positions are recomputed", () => {
    const review = play(deliberating(), [
      { type: "round-started", at: 23, round: 1 },
      argue("r3", "F1", "challenges", 24),
      argue("r1", "F3", "supports", 25),
      { type: "round-started", at: 26, round: 2 },
      argue("r3", "F1", "supports", 27),
      argue("r2", "F3", "challenges", 28),
      { type: "interrupted", at: 30 },
    ]);
    expect(review.reviewers.map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped", "stopped"]);
    // The positions as they stand in round 2.
    expect(review.findings[0]!.positions.find((position) => position.reviewerId === "r3")).toMatchObject({ stance: "supports", round: 2 });

    const resumed = reduce(review, { type: "resumed", at: 40 });
    expect(resumed).toMatchObject({ phase: "deliberation", round: 1, rounds: 2, interruptedPhase: null, endedAt: null });
    expect(resumed.arguments.map((argument) => [argument.id, argument.round])).toEqual([["A1", 1], ["A2", 1]]);
    expect(resumed.reviewers.map((reviewer) => reviewer.status)).toEqual(["deliberating", "deliberating", "deliberating"]);
    const [f1, f3] = resumed.findings;
    const positions = (each: typeof f1) => each!.positions.map((position) => [position.reviewerId, position.stance, position.round]);
    // F1: its reporter and co-reporter back at round 0, r3's round-1 challenge kept.
    expect(positions(f1)).toEqual([["r1", "supports", 0], ["r2", "supports", 0], ["r3", "challenges", 1]]);
    expect(positions(f3)).toEqual([["r3", "supports", 0], ["r1", "supports", 1]]);
  });

  test("in the first round, it goes back to round 0 with the positions of the start", () => {
    const review = play(deliberating(), [{ type: "round-started", at: 23, round: 1 }, argue("r3", "F1", "challenges", 24), { type: "interrupted", at: 30 }]);
    const resumed = reduce(review, { type: "resumed", at: 40 });
    expect(resumed).toMatchObject({ phase: "deliberation", round: 0 });
    expect(resumed.arguments).toEqual([]);
    expect(resumed.findings[0]!.positions.map((position) => [position.reviewerId, position.round])).toEqual([["r1", 0], ["r2", 0]]);
  });

  test("in the synthesis, it goes back to the deliberation's end with the findings unsettled", () => {
    const review = play(deliberating(), [
      { type: "round-started", at: 23, round: 1 },
      { type: "round-started", at: 24, round: 2 },
      { type: "synthesis-started", at: 25 },
      { type: "finding-resolved", at: 26, findingId: "F1", status: "agreed", rationale: "All back it.", dissenters: [] },
      { type: "interrupted", at: 30 },
    ]);
    expect(review.interruptedPhase).toBe("synthesis");
    const resumed = reduce(review, { type: "resumed", at: 40 });
    expect(resumed).toMatchObject({ phase: "deliberation", round: 2, rounds: 2 });
    expect(resumed.findings.map((each) => [each.status, each.resolution, each.proposal])).toEqual([["reported", null, null], ["reported", null, null]]);
    expect(resumed.reviewers.every((reviewer) => reviewer.status === "deliberating")).toBe(true);
  });

  test("a review that isn't resumable throws", () => {
    expect(() => reduce(started(), { type: "resumed", at: 10 })).toThrow(ReviewError);
    expect(() => reduce(reduce(started(), { type: "stopped", at: 10 }), { type: "resumed", at: 11 })).toThrow("Only a review a restart cut short");
    const once = reduce(reduce(started(), { type: "interrupted", at: 10 }), { type: "resumed", at: 11 });
    expect(() => reduce(once, { type: "resumed", at: 12 })).toThrow(ReviewError);
  });
});

describe("ReviewSession.resume", () => {
  const twoSeats = () => newReview("rev2", { ...setup, seats: setup.seats.slice(0, 2) }, "mock", 0);

  /** Plays a mock review until `until` holds, then returns the review as a restart would have cut it short. */
  async function interruptedWhen(until: (review: Review) => boolean) {
    const clock = new FakeClock();
    const session = new ReviewSession(twoSeats(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    void session.run();
    for (let i = 0; i < 2_000 && !until(session.review); i++) if (!(await clock.step())) break;
    expect(until(session.review)).toBe(true);
    return reduce(session.review, { type: "interrupted", at: clock.now() });
  }

  async function resumeToTheEnd(interrupted: Review) {
    expect(isResumable(interrupted)).toBe(true);
    const clock = new FakeClock();
    const session = new ReviewSession(interrupted, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.resume();
    await clock.runAll();
    return done;
  }

  test("an interruption during the independent review resumes to a verdict", async () => {
    const interrupted = await interruptedWhen((review) => review.phase === "independent-review" && review.reviewers[0]!.status === "reviewing" && review.findings.length > 0);
    expect(interrupted.interruptedPhase).toBe("independent-review");
    const final = await resumeToTheEnd(interrupted);
    expect(final.phase).toBe("complete");
    expect(final.verdict).not.toBeNull();
    expect(final.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["completed", "completed"]);
    expect(final.findings.length).toBeGreaterThan(0);
    expect(final.findings.every((each) => each.status !== "reported")).toBe(true);
  });

  test("an interruption during the deliberation resumes to a verdict", async () => {
    const interrupted = await interruptedWhen((review) => review.phase === "deliberation" && review.round >= 1);
    expect(interrupted.interruptedPhase).toBe("deliberation");
    const final = await resumeToTheEnd(interrupted);
    expect(final.phase).toBe("complete");
    expect(final.verdict).not.toBeNull();
    expect(final.round).toBe(final.rounds);
    expect(final.findings.every((each) => each.status !== "reported")).toBe(true);
  });

  test("an interruption during the synthesis resumes to a verdict", async () => {
    const interrupted = await interruptedWhen((review) => review.phase === "synthesis");
    expect(interrupted.interruptedPhase).toBe("synthesis");
    const final = await resumeToTheEnd(interrupted);
    expect(final.phase).toBe("complete");
    expect(final.verdict).not.toBeNull();
    expect(final.findings.every((each) => each.status !== "reported" && each.resolution !== null)).toBe(true);
  });
});
