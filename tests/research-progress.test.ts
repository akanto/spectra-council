import { describe, expect, test } from "bun:test";
import type { Review } from "../core/model.ts";
import { flowOf, type FlowStepId } from "../core/progress.ts";
import { newReview, reduce, type ReviewEvent } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";

const claim: ClaimInput = { rq: "RQ1", kind: "fact", title: "T", text: "A fact.", confidence: "high", fields: {}, sources: [{ url: "https://doi.org/10.1/1", doi: "10.1/1", authors: "A", title: "P", venue: "V", year: 2024, quote: "q", read: "full-text" }] };

const base = (seats = 2) =>
  newReview("rev1", { kind: "research", target: "/repo", brief: "/repo/brief.md", profile: "general", depth: "quick", instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].slice(0, seats).map((agent) => ({ agent, enabled: true })) }, "mock", 0);

const run = (review: Review, events: ReviewEvent[]) => events.reduce(reduce, review);

const started: ReviewEvent[] = [{ type: "started", at: 1 }, { type: "reviewer-started", reviewerId: "r1", at: 2 }, { type: "reviewer-started", reviewerId: "r2", at: 2 }];
const researched: ReviewEvent[] = [
  { type: "claim-reported", reviewerId: "r1", at: 3, claim },
  { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" },
  { type: "reviewer-finished", reviewerId: "r2", at: 4, outcome: "completed" },
  { type: "deliberation-started", at: 5, rounds: 2 },
];

const states = (review: Review) => Object.fromEntries(flowOf(review).steps.map((step) => [step.id, step.state])) as Record<FlowStepId, string>;
const detail = (review: Review, id: FlowStepId) => flowOf(review).steps.find((step) => step.id === id)!.detail;

describe("a research council's process strip", () => {
  test("has the six research steps in order", () => {
    expect(flowOf(base()).steps.map((step) => step.id)).toEqual(["setup", "research", "sources", "deliberate", "answer", "followup"]);
  });

  test("setup", () => {
    const flow = states(base());
    expect(flow.setup).toBe("current");
    expect(flow.research).toBe("ahead");
    expect(flow.followup).toBe("ahead");
  });

  test("research counts the seats done", () => {
    let review = run(base(), started);
    expect(states(review).research).toBe("current");
    expect(detail(review, "research")).toBe("0 of 2 researched");
    review = run(review, [{ type: "reviewer-finished", reviewerId: "r1", at: 3, outcome: "completed" }]);
    expect(detail(review, "research")).toBe("1 of 2 researched");
  });

  test("checks sources before the first round, then deliberates", () => {
    let review = run(base(), [...started, ...researched]);
    expect(states(review)).toMatchObject({ setup: "done", research: "done", sources: "current", deliberate: "ahead" });
    expect(detail(review, "sources")).toBe("checking sources");
    review = run(review, [{ type: "sources-checked", at: 6 }, { type: "round-started", at: 7, round: 1 }]);
    expect(states(review)).toMatchObject({ sources: "done", deliberate: "current" });
    expect(detail(review, "deliberate")).toBe("round 1 of 2");
  });

  test("the answer is drafted, checked and revised", () => {
    let review = run(base(), [...started, ...researched, { type: "sources-checked", at: 6 }, { type: "synthesis-started", at: 8 }]);
    expect(states(review)).toMatchObject({ deliberate: "done", answer: "current" });
    expect(detail(review, "answer")).toBe("drafting");
    review = run(review, [{ type: "answer-drafted", reviewerId: "r1", at: 9, markdown: "A [C1].", problems: [] }]);
    expect(detail(review, "answer")).toBe("checking the draft");
    review = run(review, [{ type: "draft-objected", reviewerId: "r2", at: 10, objection: { claimId: "C1", excerpt: "A", problem: "wrong" } }]);
    expect(detail(review, "answer")).toBe("revising");
  });

  test("complete: the answer is written and a follow-up is optional", () => {
    const review = run(base(), [
      ...started,
      ...researched,
      { type: "sources-checked", at: 6 },
      { type: "synthesis-started", at: 8 },
      { type: "answer-drafted", reviewerId: "r1", at: 9, markdown: "A [C1].", problems: [] },
      { type: "answer-written", at: 10, path: "/repo/brief-answer.md", digest: "d" },
      { type: "concluded", at: 11, summary: "Done." },
    ]);
    const flow = flowOf(review);
    expect(states(review)).toMatchObject({ setup: "done", research: "done", sources: "done", deliberate: "done", answer: "done", followup: "ahead" });
    expect(detail(review, "answer")).toBe("answer written");
    expect(flow.settled).toBe(true);
  });

  test("a follow-up run is the current step, and done once it ends", () => {
    let review = run(base(), [
      ...started,
      ...researched,
      { type: "sources-checked", at: 6 },
      { type: "synthesis-started", at: 8 },
      { type: "answer-drafted", reviewerId: "r1", at: 9, markdown: "A [C1].", problems: [] },
      { type: "answer-written", at: 10, path: "/repo/brief-answer.md", digest: "d" },
      { type: "concluded", at: 11, summary: "Done." },
      { type: "follow-up-asked", at: 12, question: "More?" },
      { type: "follow-up-started", at: 13 },
    ]);
    expect(states(review)).toMatchObject({ research: "done", answer: "done", followup: "current" });
    expect(detail(review, "followup")).toMatch(/researched/);
    review = run(review, [{ type: "stopped", at: 14 }]);
    expect(states(review).followup).toBe("stopped");
  });

  test("with one seat the rounds and the source check are skipped", () => {
    const review = run(base(1), [
      { type: "started", at: 1 },
      { type: "reviewer-started", reviewerId: "r1", at: 2 },
      { type: "claim-reported", reviewerId: "r1", at: 3, claim },
      { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" },
      { type: "deliberation-started", at: 5, rounds: 0 },
      { type: "synthesis-started", at: 6 },
    ]);
    expect(states(review)).toMatchObject({ research: "done", sources: "skipped", deliberate: "skipped", answer: "current" });
  });

  test("a stop cuts the step it came in", () => {
    const review = run(base(), [...started, { type: "stopped", at: 5 }]);
    expect(states(review)).toMatchObject({ setup: "done", research: "stopped", sources: "ahead", followup: "ahead" });
  });
});
