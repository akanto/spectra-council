import { describe, expect, test } from "bun:test";
import { modelLabel, seatDetail, withLabels } from "../core/agents.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce, upgradeReview } from "../core/review.ts";
import type { Seat } from "../core/schemas.ts";

const review = (agents: string[]): Review =>
  newReview("rev", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: agents.map((agent): Seat => ({ agent, enabled: true })) }, "mixed", 0);
const opus = { name: "Opus 5.5", effort: "high" };
const labels = (it: Review) => it.reviewers.map((reviewer) => reviewer.label);

describe("reviewer labels", () => {
  test("a profile seat is named by its profile until its model is seen, then by the model", () => {
    let it = review(["profile:Home", "mock-codex"]);
    expect(labels(it)).toEqual(["Home", "Codex"]);
    it = reduce(it, { type: "model-seen", reviewerId: "r1", model: opus });
    expect(labels(it)).toEqual(["Opus 5.5", "Codex"]);
    expect(it.reviewers[0]!.model).toEqual(opus);
  });

  test("the same model on two profiles is told apart by profile, the same mock by number", () => {
    let it = review(["profile:Home", "profile:Work", "mock-claude", "mock-claude"]);
    it = reduce(it, { type: "model-seen", reviewerId: "r1", model: opus });
    it = reduce(it, { type: "model-seen", reviewerId: "r2", model: opus });
    expect(labels(it)).toEqual(["Opus 5.5 (Home)", "Opus 5.5 (Work)", "Claude 1", "Claude 2"]);
  });

  test("seeing the same model again changes nothing", () => {
    const seen = reduce(review(["profile:Home"]), { type: "model-seen", reviewerId: "r1", model: opus });
    expect(reduce(seen, { type: "model-seen", reviewerId: "r1", model: { ...opus } })).toBe(seen);
  });

  test("a model is seen in any phase, and an unknown reviewer is refused", () => {
    const started = reduce(review(["profile:Home"]), { type: "started", at: 1 });
    expect(reduce(started, { type: "model-seen", reviewerId: "r1", model: opus }).reviewers[0]!.label).toBe("Opus 5.5");
    expect(() => reduce(started, { type: "model-seen", reviewerId: "r9", model: opus })).toThrow("No reviewer r9");
  });

  test("configuring keeps a seat's model while its agent stays, and drops it when the agent changes", () => {
    const seen = reduce(review(["profile:Home", "mock-codex"]), { type: "model-seen", reviewerId: "r1", model: opus });
    const added = reduce(seen, { type: "configured", patch: { seats: [{ agent: "profile:Home", enabled: true }, { agent: "mock-codex", enabled: true }, { agent: "mock-qwen", enabled: true }] } });
    expect(added.reviewers.map((reviewer) => [reviewer.id, reviewer.label])).toEqual([["r1", "Opus 5.5"], ["r2", "Codex"], ["r3", "Qwen"]]);
    const swapped = reduce(added, { type: "configured", patch: { seats: [{ agent: "profile:Work", enabled: true }] } });
    expect(swapped.reviewers.map((reviewer) => [reviewer.id, reviewer.label, reviewer.model])).toEqual([["r1", "Work", null]]);
  });

  test("a format-4 review gets no model on its reviewers", () => {
    const old = { ...review(["profile:Home"]), format: 4 } as unknown as Review;
    for (const reviewer of old.reviewers) delete (reviewer as Partial<typeof reviewer>).model;
    expect(upgradeReview(old).reviewers[0]!.model).toBeNull();
  });

  test("withLabels returns the same reviewer objects when nothing changes", () => {
    const it = review(["mock-codex"]);
    expect(withLabels(it.reviewers)[0]).toBe(it.reviewers[0]!);
  });

  test("model and seat details in words", () => {
    expect(modelLabel(opus)).toBe("Opus 5.5 · high");
    expect(modelLabel({ name: "Qwen 3.8 Max", effort: null })).toBe("Qwen 3.8 Max");
    expect(seatDetail({ agent: "profile:Home", model: opus })).toBe("high effort · Home profile");
    expect(seatDetail({ agent: "profile:Home", model: null })).toBe("Home profile");
    expect(seatDetail({ agent: "mock-codex", model: null })).toBe("mock");
  });
});
