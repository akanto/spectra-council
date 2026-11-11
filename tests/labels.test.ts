import { describe, expect, test } from "bun:test";
import { modelLabel, seatDetail, shortName, withLabels } from "../core/agents.ts";
import type { Review } from "../core/model.ts";
import { describeReview } from "../core/describe.ts";
import { newReview, reduce, upgradeReview } from "../core/review.ts";
import type { Seat } from "../core/schemas.ts";

const review = (agents: string[]): Review =>
  newReview("rev", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: agents.map((agent): Seat => ({ agent, enabled: true })) }, "mixed", 0);
const opus = { name: "Opus 5.5", effort: "high" };
const labels = (it: Review) => it.reviewers.map((reviewer) => reviewer.label);

describe("reviewer labels", () => {
  test("a profile seat is named by its number and profile until its model is seen, then by its model and effort", () => {
    let it = review(["profile:Home", "mock-codex"]);
    expect(labels(it)).toEqual(["R1 · Home", "R2 · Codex (mock)"]);
    it = reduce(it, { type: "model-seen", reviewerId: "r1", model: opus });
    expect(labels(it)).toEqual(["R1 · Opus 5.5 · high", "R2 · Codex (mock)"]);
    expect(labels(reduce(it, { type: "model-seen", reviewerId: "r1", model: { name: "Qwen 3.8 Max", effort: null } }))[0]).toBe("R1 · Qwen 3.8 Max");
    expect(it.reviewers[0]!.model).toEqual(opus);
  });

  test("seats on the same model or mock are told apart by their number, never by profile", () => {
    let it = review(["profile:Home", "profile:Work", "mock-claude", "mock-claude"]);
    it = reduce(it, { type: "model-seen", reviewerId: "r1", model: opus });
    it = reduce(it, { type: "model-seen", reviewerId: "r2", model: opus });
    expect(labels(it)).toEqual(["R1 · Opus 5.5 · high", "R2 · Opus 5.5 · high", "R3 · Claude (mock)", "R4 · Claude (mock)"]);
  });

  test("seeing the same model again changes nothing", () => {
    const seen = reduce(review(["profile:Home"]), { type: "model-seen", reviewerId: "r1", model: opus });
    expect(reduce(seen, { type: "model-seen", reviewerId: "r1", model: { ...opus } })).toBe(seen);
  });

  test("a model is seen in any phase, and an unknown reviewer is refused", () => {
    const started = reduce(review(["profile:Home"]), { type: "started", at: 1 });
    expect(reduce(started, { type: "model-seen", reviewerId: "r1", model: opus }).reviewers[0]!.label).toBe("R1 · Opus 5.5 · high");
    expect(() => reduce(started, { type: "model-seen", reviewerId: "r9", model: opus })).toThrow("No reviewer r9");
  });

  test("configuring keeps a seat's model while its agent stays, and drops it when the agent changes", () => {
    const seen = reduce(review(["profile:Home", "mock-codex"]), { type: "model-seen", reviewerId: "r1", model: opus });
    const added = reduce(seen, { type: "configured", patch: { seats: [{ agent: "profile:Home", enabled: true }, { agent: "mock-codex", enabled: true }, { agent: "mock-qwen", enabled: true }] } });
    expect(added.reviewers.map((reviewer) => [reviewer.id, reviewer.label])).toEqual([["r1", "R1 · Opus 5.5 · high"], ["r2", "R2 · Codex (mock)"], ["r3", "R3 · Qwen (mock)"]]);
    const swapped = reduce(added, { type: "configured", patch: { seats: [{ agent: "profile:Work", enabled: true }] } });
    expect(swapped.reviewers.map((reviewer) => [reviewer.id, reviewer.label, reviewer.model])).toEqual([["r1", "R1 · Work", null]]);
  });

  test("a format-4 review gets no model on its reviewers", () => {
    const old = { ...review(["profile:Home"]), format: 4 } as unknown as Review;
    for (const reviewer of old.reviewers) delete (reviewer as Partial<typeof reviewer>).model;
    expect(upgradeReview(old).reviewers[0]!.model).toBeNull();
  });

  test("a review saved before keeps its labels until a seat is relabelled", () => {
    const old = { ...review(["profile:Home"]), reviewers: review(["profile:Home"]).reviewers.map((reviewer) => ({ ...reviewer, label: "Opus 5.5 (Home)" })) };
    expect(reduce(old, { type: "started", at: 1 }).reviewers[0]!.label).toBe("Opus 5.5 (Home)");
  });

  test("the agent's status still names each profile seat's profile", () => {
    let it = review(["profile:Home", "profile:Work", "mock-codex"]);
    it = reduce(it, { type: "model-seen", reviewerId: "r1", model: opus });
    it = reduce(it, { type: "model-seen", reviewerId: "r2", model: opus });
    expect(describeReview(it)).toContain("Reviewers: R1 · Opus 5.5 · high (Home profile, idle), R2 · Opus 5.5 · high (Work profile, idle), R3 · Codex (mock) (idle).");
  });

  test("a sentence names a reviewer by its seat number, or an old review's by its whole label", () => {
    expect(shortName({ label: "R2 · Opus 5.5 · high" })).toBe("R2");
    expect(shortName({ label: "R12 · Claude (mock)" })).toBe("R12");
    expect(shortName({ label: "Opus 5.5 (Home)" })).toBe("Opus 5.5 (Home)");
    expect(shortName({ label: "Rex" })).toBe("Rex");
  });

  test("withLabels returns the same reviewer objects when nothing changes", () => {
    const it = review(["mock-codex"]);
    expect(withLabels(it.reviewers)[0]).toBe(it.reviewers[0]!);
  });

  test("model and seat details in words", () => {
    expect(modelLabel(opus)).toBe("Opus 5.5 · high");
    expect(modelLabel({ name: "Qwen 3.8 Max", effort: null })).toBe("Qwen 3.8 Max");
    expect(seatDetail({ agent: "profile:Home" })).toBe("Home profile");
    expect(seatDetail({ agent: "mock-codex" })).toBe("Mock reviewer: fast, code-path focused.");
  });
});
