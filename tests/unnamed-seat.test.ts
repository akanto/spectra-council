import { describe, expect, test } from "bun:test";
import { profileAgent, runnerKindOf, UNNAMED_PROFILE } from "../core/agents.ts";
import { newReview, reduce, ReviewError } from "../core/review.ts";

/** A seat added once every known profile sits at the council: it waits for a profile's name, never a mock. */
const setup = (agents: string[]) => ({ target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: agents.map((agent) => ({ agent, enabled: true })) });

describe("an unnamed profile seat", () => {
  test("counts as a Mirador seat, not a mock", () => {
    expect(runnerKindOf(setup([profileAgent("home"), UNNAMED_PROFILE]).seats)).toBe("mirador");
  });

  test("shows as an unnamed profile", () => {
    const review = newReview("r", setup([profileAgent("home"), UNNAMED_PROFILE]), "mirador", 0);
    expect(review.reviewers[1]?.label).toBe("Unnamed profile");
  });

  test("keeps the review from starting until it is named", () => {
    const review = newReview("r", setup([profileAgent("home"), UNNAMED_PROFILE]), "mirador", 0);
    expect(() => reduce(review, { type: "started", at: 1 })).toThrow(ReviewError);
    expect(() => reduce(review, { type: "started", at: 1 })).toThrow("reviewer 2");
    const named = reduce(review, { type: "configured", patch: { seats: [profileAgent("home"), profileAgent("pi")].map((agent) => ({ agent, enabled: true })) } });
    expect(reduce(named, { type: "started", at: 1 }).phase).toBe("independent-review");
  });
});
