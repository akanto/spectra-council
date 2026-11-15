import { describe, expect, test } from "bun:test";
import { ReviewSession } from "../core/engine.ts";
import { MockRunner } from "../core/mock-runner.ts";
import type { Review } from "../core/model.ts";
import { draftProblems } from "../core/research.ts";
import { newReview, reduce } from "../core/review.ts";
import { claimInputSchema } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const council = (seats = ["mock-claude", "mock-codex", "mock-gemini"]) =>
  newReview("rev1", { kind: "research", target: "/repo", brief: "/repo/brief.md", profile: "general", depth: "standard", instructions: "", seats: seats.map((agent) => ({ agent, enabled: true })) }, "mock", 0);

async function play(review: Review, work: (session: ReviewSession) => Promise<Review> = (session) => session.run()) {
  const clock = new FakeClock();
  const session = new ReviewSession(review, {
    runner: new MockRunner(async () => FILES, clock),
    clock,
    onChange: () => {},
    writeAnswer: async () => ({ path: "/repo/brief-answer.md", digest: "d" }),
  });
  const done = work(session);
  await clock.runAll();
  return done;
}

describe("mock research council", () => {
  test("runs the whole flow with claims of several statuses and a clean draft", async () => {
    const review = await play(council());
    const research = review.research!;
    expect(review.phase).toBe("complete");
    expect(research.claims.length).toBeGreaterThanOrEqual(3);
    const statuses = new Set(research.claims.map((claim) => claim.status));
    expect(statuses.size).toBeGreaterThanOrEqual(3);
    expect(statuses.has("unverified")).toBe(true);
    expect(research.drafts.length).toBeGreaterThanOrEqual(1);
    expect(research.drafts.length).toBeLessThanOrEqual(2);
    expect(research.drafts.at(-1)!.problems).toEqual([]);
    expect(draftProblems(review, research.drafts.at(-1)!.markdown)).toEqual([]);
    for (const claim of research.claims) {
      for (const source of claim.sources) {
        expect(source.url).toStartWith("https://example.org/mock/");
        expect(source.doi).toBeUndefined();
        expect(source.title).toEndWith("(mock)");
      }
    }
  });

  test("is deterministic", async () => {
    const a = await play(council());
    const b = await play(council());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("claims parse with the claim schema and respect the limit", async () => {
    const review = await play(council());
    for (const claim of review.research!.claims) {
      const { id: _id, reviewerId: _r, pass: _p, status: _s, reportedAt: _t, positions: _po, resolution: _re, alsoReported: _a, ruling: _ru, ...input } = claim;
      expect(claimInputSchema.safeParse({ ...input, sources: claim.sources.map(({ checks: _c, ...source }) => source) }).success).toBe(true);
    }
    for (const reviewer of review.reviewers) expect(review.research!.claims.filter((claim) => claim.reviewerId === reviewer.id || claim.alsoReported.some((each) => each.reviewerId === reviewer.id)).length).toBeLessThanOrEqual(review.maxFindings);
  });

  test("a follow-up adds claims of the new run and a new draft", async () => {
    let review = await play(council());
    review = reduce(review, { type: "follow-up-asked", at: 5, question: "What about chunked formats?" });
    review = await play(review, (session) => session.followUp());
    const added = review.research!.claims.filter((claim) => claim.pass === 1);
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(review.research!.drafts.at(-1)).toMatchObject({ pass: 1 });
    expect(review.research!.drafts.at(-1)!.problems).toEqual([]);
    expect(review.phase).toBe("complete");
  });
});
