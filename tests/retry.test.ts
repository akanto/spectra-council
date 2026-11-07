import { describe, expect, test } from "bun:test";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce, ReviewError } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { FakeClock } from "./support.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].map((agent, index) => ({ agent, enabled: index < 2 })) };
const fresh = () => newReview("rev1", setup, "mock", 0);

const finding = (title: string): FindingInput => ({ title, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 3 }] });

/** r1 reviewing, r2 failed after reporting one finding, r3 not seated. */
function withFailedR2(): Review {
  let review = reduce(fresh(), { type: "started", at: 1 });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Mine") });
  review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 4, finding: finding("Theirs") });
  return reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 5, outcome: "failed", problem: "crashed" });
}

describe("reviewer-retried", () => {
  test("a failed reviewer waits again, without its findings, problem and times, and the retry is logged", () => {
    const retried = reduce(withFailedR2(), { type: "reviewer-retried", reviewerId: "r2", at: 10 });
    expect(retried.findings.map((each) => each.title)).toEqual(["Mine"]);
    expect(retried.reviewers[1]).toMatchObject({ status: "waiting", problem: null, startedAt: null, endedAt: null });
    expect(retried.reviewers[1]!.activity.at(-1)).toMatchObject({ kind: "status", text: "Retrying", at: 10 });
    expect(retried.reviewers[0]!.status).toBe("reviewing");
    // The ids already given out aren't reused.
    expect(retried.findingsIssued).toBe(2);
    const again = reduce(retried, { type: "reviewer-started", reviewerId: "r2", at: 11 });
    expect(reduce(again, { type: "finding-reported", reviewerId: "r2", at: 12, finding: finding("New") }).findings.at(-1)!.id).toBe("F3");
  });

  test("only a failed, seated reviewer, and only in the independent review", () => {
    const review = withFailedR2();
    expect(() => reduce(review, { type: "reviewer-retried", reviewerId: "r1", at: 10 })).toThrow(ReviewError);
    expect(() => reduce(review, { type: "reviewer-retried", reviewerId: "r3", at: 10 })).toThrow("takes part");
    expect(() => reduce(review, { type: "reviewer-retried", reviewerId: "r9", at: 10 })).toThrow("takes part");
    expect(() => reduce(fresh(), { type: "reviewer-retried", reviewerId: "r2", at: 10 })).toThrow("independent review");
    const done = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 6, outcome: "completed" });
    const deliberating = reduce(done, { type: "deliberation-started", at: 7, rounds: 1 });
    expect(() => reduce(deliberating, { type: "reviewer-retried", reviewerId: "r2", at: 10 })).toThrow("independent review");
  });
});

describe("ReviewSession.retry", () => {
  /** r2 fails on its first run and succeeds on its second; r1 is still running until 10 s have passed. */
  function setupSession() {
    const clock = new FakeClock();
    const runs = new Map<string, number>();
    const runner: ReviewerRunner = {
      async run(job, report, signal) {
        const count = (runs.get(job.reviewer.id) ?? 0) + 1;
        runs.set(job.reviewer.id, count);
        if (job.reviewer.id === "r1") {
          report({ type: "finding-reported", finding: finding("Alpha leak") });
          await clock.sleep(10_000, signal);
          return;
        }
        if (count === 1) {
          report({ type: "finding-reported", finding: finding("Gamma crash") });
          throw new Error("agent crashed");
        }
        await clock.sleep(1_000, signal);
        report({ type: "finding-reported", finding: finding("Beta deadlock") });
      },
      async deliberate() {},
      async propose() {},
      async verify() {},
    };
    const session = new ReviewSession(fresh(), { runner, clock, onChange: () => {} });
    return { clock, runs, session };
  }

  test("the review waits for the retried run and concludes with the reviewer completed and its findings in", async () => {
    const { clock, runs, session } = setupSession();
    const done = session.run();
    await clock.settle();
    expect(session.review.reviewers[1]).toMatchObject({ status: "failed", problem: "agent crashed" });
    expect(session.review.reviewers[0]!.status).toBe("reviewing");
    session.retry("r2");
    expect(session.review.reviewers[1]!.status).toBe("reviewing");
    expect(session.review.findings.map((each) => each.title)).toEqual(["Alpha leak"]);
    await clock.runAll();
    const final = await done;
    expect(runs.get("r2")).toBe(2);
    expect(final.phase).toBe("complete");
    expect(final.reviewers[1]).toMatchObject({ status: "completed", problem: null });
    expect(final.findings.map((each) => each.title).sort()).toEqual(["Alpha leak", "Beta deadlock"]);
  });

  test("a retry after the other reviewers finished still holds the review back", async () => {
    const { clock, session } = setupSession();
    const done = session.run();
    await clock.settle();
    session.retry("r2");
    // r1 (10 s) outlasts the retry (1 s); the review is still independent in between.
    await clock.step();
    expect(session.review.phase).toBe("independent-review");
    expect(session.review.reviewers[1]!.status).toBe("completed");
    await clock.runAll();
    expect((await done).phase).toBe("complete");
  });

  test("retrying a reviewer that didn't fail, or a review not in the independent phase, throws", async () => {
    const { clock, session } = setupSession();
    const done = session.run();
    await clock.settle();
    expect(() => session.retry("r1")).toThrow(ReviewError);
    session.retry("r2");
    await clock.runAll();
    await done;
    expect(session.review.phase).toBe("complete");
    expect(() => session.retry("r2")).toThrow("independent review");
  });
});
