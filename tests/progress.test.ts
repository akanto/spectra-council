import { describe, expect, test } from "bun:test";
import { flowOf, type FlowStepId } from "../core/progress.ts";
import type { Fix, FixState, Review } from "../core/model.ts";
import { newReview, reduce } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";

const seatsOf = (count: number) => ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent, index) => ({ agent, enabled: index < count }));
const setup = (seats: number) => ({ target: "/repo", profile: "code" as const, depth: "standard" as const, instructions: "", seats: seatsOf(seats) });
const finding: FindingInput = { title: "Off by one", summary: "Drops the last element.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 3 }] };

const fresh = (seats = 2) => newReview("rev1", setup(seats), "mock", 0);
const ids = (seats: number) => ["r1", "r2", "r3", "r4"].slice(0, seats);

/** Started, every seated reviewer done, F1 (by r1) and F2 (by r2) reported. */
function reviewed(seats = 2): Review {
  let review = reduce(fresh(seats), { type: "started", at: 10 });
  for (const reviewerId of ids(seats)) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 12, finding });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...finding, title: "Race" } });
  for (const reviewerId of ids(seats)) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" });
  return review;
}
const inRound = (round = 2) => {
  let review = reduce(reviewed(), { type: "deliberation-started", at: 30, rounds: 3 });
  for (let n = 1; n <= round; n++) review = reduce(review, { type: "round-started", at: 30 + n, round: n });
  return review;
};
function settling(): Review {
  let review = reduce(inRound(1), { type: "synthesis-started", at: 49 });
  review = reduce(review, { type: "finding-resolved", at: 50, findingId: "F1", status: "agreed", rationale: "All back it.", dissenters: [] });
  review = reduce(review, { type: "finding-resolved", at: 51, findingId: "F2", status: "withdrawn", rationale: "Conceded.", dissenters: [] });
  return review;
}
const concluded = () => reduce(settling(), { type: "concluded", at: 60, summary: "Done." });

const fixOf = (state: FixState): Fix => ({ state, handedOffAt: 62, fixer: null, problem: null, summary: null, files: [], fixedAt: state === "handed-off" ? null : 64, checks: [] });
/** Sets F1 (the only standing finding in `concluded()`). */
const withF1 = (review: Review, patch: Partial<Review["findings"][number]>): Review => ({
  ...review,
  findings: review.findings.map((it) => (it.id === "F1" ? { ...it, ...patch } : it)),
});
const ruling = (decision: "accepted" | "dismissed" | "deferred") => ({ decision, note: "", at: 61 });
const stateOf = (review: Review, id: FlowStepId) => flowOf(review).steps.find((step) => step.id === id)!;
const states = (review: Review) => flowOf(review).steps.map((step) => step.state);

describe("flowOf", () => {
  test("it always returns the six steps in order, with at most one current", () => {
    const reviews: Review[] = [
      fresh(),
      reviewed(),
      inRound(),
      settling(),
      concluded(),
      withF1(concluded(), { ruling: ruling("accepted"), fix: fixOf("fixed") }),
      { ...concluded(), phase: "verification" },
      reduce(inRound(), { type: "stopped", at: 45 }),
      reduce(inRound(), { type: "interrupted", at: 45 }),
    ];
    for (const review of reviews) {
      const flow = flowOf(review);
      expect(flow.steps.map((step) => step.id)).toEqual(["setup", "review", "deliberate", "verdict", "rule", "recheck"]);
      expect(flow.steps.filter((step) => step.state === "current").length).toBeLessThanOrEqual(1);
    }
  });

  describe("before and during the run", () => {
    test("setup is current, and the deliberation shows its rounds", () => {
      const review = fresh();
      expect(states(review)).toEqual(["current", "ahead", "ahead", "ahead", "ahead", "ahead"]);
      expect(stateOf(review, "deliberate").detail).toBe(`${review.deliberationRounds} rounds`);
      expect(stateOf(review, "deliberate").detail).toBe("3 rounds");
      expect(stateOf(review, "review").detail).toContain(`≤${review.maxFindings} findings`);
    });

    test("one reviewer skips the deliberation", () => {
      const review = fresh(1);
      expect(stateOf(review, "deliberate")).toMatchObject({ state: "skipped", detail: "skipped: 1 reviewer" });
      expect(stateOf(review, "setup").state).toBe("current");
    });

    test("the independent review counts the reviewers done, failed ones too", () => {
      let review = reduce(fresh(), { type: "started", at: 10 });
      for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
      expect(states(review).slice(0, 2)).toEqual(["done", "current"]);
      expect(stateOf(review, "review").detail).toBe("0 of 2 done");
      review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" });
      expect(stateOf(review, "review").detail).toBe("1 of 2 done");
      review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 21, outcome: "failed", problem: "crashed" });
      expect(stateOf(review, "review").detail).toBe("2 of 2 done");
    });

    test("the deliberation shows its round, or the grouping before round 1", () => {
      const review = inRound(2);
      expect(states(review)).toEqual(["done", "done", "current", "ahead", "ahead", "ahead"]);
      expect(stateOf(review, "deliberate").detail).toBe("round 2 of 3");
      const grouping = reduce(reviewed(), { type: "deliberation-started", at: 30, rounds: 3 });
      expect(grouping.round).toBe(0);
      expect(stateOf(grouping, "deliberate")).toMatchObject({ state: "current", detail: "grouping" });
    });

    test("the synthesis is the verdict step", () => {
      expect(states(settling())).toEqual(["done", "done", "done", "current", "ahead", "ahead"]);
    });
  });

  describe("after the verdict", () => {
    test("with standing findings unruled, the rule step is current", () => {
      const review = concluded();
      expect(states(review)).toEqual(["done", "done", "done", "done", "current", "ahead"]);
      expect(flowOf(review).settled).toBe(false);
    });

    test("all ruled and none accepted: rule done, no re-check, settled", () => {
      const review = withF1(concluded(), { ruling: ruling("dismissed") });
      expect(states(review)).toEqual(["done", "done", "done", "done", "done", "skipped"]);
      expect(flowOf(review).settled).toBe(true);
    });

    test("an accepted finding with no fix and no ticket keeps the rule step current", () => {
      const review = withF1(concluded(), { ruling: ruling("accepted") });
      expect(stateOf(review, "rule").state).toBe("current");
      expect(flowOf(review).settled).toBe(false);
    });

    test("an accepted finding filed as an issue completes the rule step; a ticket without an id doesn't", () => {
      const filed = withF1(concluded(), { ruling: ruling("accepted"), ticket: { id: "spectra-council-x1y", requestedAt: 62, filedAt: 63 } });
      expect(stateOf(filed, "rule").state).toBe("done");
      expect(stateOf(filed, "recheck").state).toBe("skipped");
      expect(flowOf(filed).settled).toBe(true);
      const asked = withF1(concluded(), { ruling: ruling("accepted"), ticket: { id: null, requestedAt: 62, filedAt: null } });
      expect(stateOf(asked, "rule").state).toBe("current");
    });

    test("a fixed finding leaves the re-check current", () => {
      const review = withF1(concluded(), { ruling: ruling("accepted"), fix: fixOf("fixed") });
      expect(states(review)).toEqual(["done", "done", "done", "done", "done", "current"]);
      expect(stateOf(review, "recheck").detail).toBe("1 to check");
      expect(flowOf(review).settled).toBe(false);
    });

    test("a handed-off fix keeps the rule step current", () => {
      const review = withF1(concluded(), { ruling: ruling("accepted"), fix: fixOf("handed-off") });
      expect(stateOf(review, "rule").state).toBe("current");
    });

    test("during the verification the re-check is current and the rule step done", () => {
      const review: Review = { ...withF1(concluded(), { ruling: ruling("accepted"), fix: { ...fixOf("fixed"), recheckedIn: 1 } }), phase: "verification", verifications: 1 };
      expect(stateOf(review, "rule").state).toBe("done");
      expect(stateOf(review, "recheck")).toMatchObject({ state: "current", detail: "checking 1" });
      expect(flowOf(review).settled).toBe(false);
    });

    test("a re-check counts only the fixes put to its pass", () => {
      let review: Review = { ...withF1(concluded(), { ruling: ruling("accepted"), fix: { ...fixOf("fixed"), recheckedIn: 1 } }), phase: "verification", verifications: 1 };
      // F2, reported fixed during the pass, waits for the next one.
      review = { ...review, findings: review.findings.map((it) => (it.id === "F2" ? { ...it, ruling: ruling("accepted"), fix: fixOf("fixed") } : it)) };
      expect(stateOf(review, "recheck").detail).toBe("checking 1");
    });

    test("a ticketed finding whose fix is still being made leaves the rule step current, not settled", () => {
      const review = withF1(concluded(), { ruling: ruling("accepted"), ticket: { id: "bd-1", requestedAt: 61, filedAt: 62 }, fix: fixOf("handed-off") });
      expect(stateOf(review, "rule").state).toBe("current");
      expect(stateOf(review, "recheck").state).toBe("ahead");
      expect(flowOf(review).settled).toBe(false);
    });

    test("after a re-check with every fix verified, the review is settled", () => {
      const review: Review = { ...withF1(concluded(), { ruling: ruling("accepted"), fix: fixOf("verified") }), verifications: 1 };
      expect(states(review)).toEqual(["done", "done", "done", "done", "done", "done"]);
      expect(flowOf(review).settled).toBe(true);
    });

    test("a reopened fix puts the rule step current again", () => {
      const review: Review = { ...withF1(concluded(), { ruling: ruling("accepted"), fix: fixOf("reopened") }), verifications: 1 };
      expect(stateOf(review, "rule").state).toBe("current");
      expect(flowOf(review).settled).toBe(false);
    });

    test("a review that concluded with no rounds and two seats skipped the deliberation", () => {
      const review = reduce(reviewed(), { type: "concluded", at: 25, summary: "Done." });
      expect(review.rounds).toBe(0);
      expect(stateOf(review, "deliberate").state).toBe("skipped");
    });
  });

  describe("stopped and interrupted", () => {
    test("a stop in the deliberation marks it stopped, with the steps before done and after ahead", () => {
      const review = reduce(inRound(2), { type: "stopped", at: 45 });
      expect(review.stoppedPhase).toBe("deliberation");
      expect(states(review)).toEqual(["done", "done", "stopped", "ahead", "ahead", "ahead"]);
      expect(flowOf(review).settled).toBe(false);
    });

    test("an interruption in the independent review marks the review step interrupted", () => {
      let review = reduce(fresh(), { type: "started", at: 10 });
      review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 11 });
      review = reduce(review, { type: "interrupted", at: 12 });
      expect(review.interruptedPhase).toBe("independent-review");
      expect(states(review)).toEqual(["done", "interrupted", "ahead", "ahead", "ahead", "ahead"]);
      expect(flowOf(review).settled).toBe(false);
    });

    test("a reviewer removed after the rounds doesn't make the deliberation skipped", () => {
      const review: Review = { ...concluded(), reviewers: concluded().reviewers.map((it) => (it.id === "r2" ? { ...it, enabled: false } : it)) };
      expect(stateOf(review, "deliberate")).toMatchObject({ state: "done", detail: "3 rounds" });
    });

    test("a stopped review stored without stoppedPhase at all is guessed too", () => {
      const { stoppedPhase: _s, ...stopped } = reduce(inRound(2), { type: "stopped", at: 45 });
      expect(stateOf(stopped as Review, "deliberate").state).toBe("stopped");
    });

    test("a stop recorded before the phase was kept is guessed from the rounds", () => {
      const inDeliberation = { ...reduce(inRound(2), { type: "stopped", at: 45 }), stoppedPhase: null };
      expect(inDeliberation.rounds).toBeGreaterThan(0);
      expect(stateOf(inDeliberation, "deliberate").state).toBe("stopped");
      expect(stateOf(inDeliberation, "review").state).toBe("done");
      let early = reduce(fresh(), { type: "started", at: 10 });
      early = reduce(early, { type: "reviewer-started", reviewerId: "r1", at: 11 });
      early = { ...reduce(early, { type: "stopped", at: 12 }), stoppedPhase: null };
      expect(early.rounds).toBe(0);
      expect(states(early)).toEqual(["done", "stopped", "ahead", "ahead", "ahead", "ahead"]);
    });
  });
});
