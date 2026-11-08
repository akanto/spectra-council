import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settle, verdictSummary } from "../core/deliberation.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce, ReviewError, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].map((agent) => ({ agent, enabled: true })) };
const fresh = () => newReview("rev1", setup, "mock", 0);

const finding = (title: string, path: string): FindingInput => ({ title, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path, line: 3 }] });

const play = (review: Review, events: ReviewEvent[]) => events.reduce(reduce, review);
const started = () => play(fresh(), [{ type: "started", at: 1 }, ...["r1", "r2", "r3"].map((reviewerId): ReviewEvent => ({ type: "reviewer-started", reviewerId, at: 2 }))]);
const finish = (reviewerId: string, outcome: "completed" | "failed" = "completed"): ReviewEvent => ({ type: "reviewer-finished", reviewerId, at: 10, outcome, ...(outcome === "failed" ? { problem: "crashed" } : {}) });

/** In the independent review: r1 and r3 still reviewing; r2 reported F2 and then failed. r1 reported F1. */
function withFailedR2(): Review {
  return play(started(), [
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Alpha leak", "src/a.ts") },
    { type: "finding-reported", reviewerId: "r2", at: 4, finding: finding("Beta deadlock", "src/b.ts") },
    finish("r2", "failed"),
  ]);
}

/** Everybody but r2 completed, r2 failed; deliberation under way (r1 and r3 deliberating). */
function deliberatingWithFailedR2(): Review {
  return play(withFailedR2(), [
    { type: "finding-reported", reviewerId: "r3", at: 5, finding: finding("Gamma crash", "src/c.ts") },
    finish("r1"),
    finish("r3"),
    { type: "deliberation-started", at: 11, rounds: 2 },
  ]);
}

const r2Of = (review: Review) => review.reviewers[1]!;

describe("reviewer-removed", () => {
  test("a failed reviewer is disabled, logged, and loses its positions and its findings in the independent review", () => {
    const removed = reduce(withFailedR2(), { type: "reviewer-removed", reviewerId: "r2", at: 20 });
    expect(r2Of(removed).enabled).toBe(false);
    expect(r2Of(removed).activity.at(-1)).toMatchObject({ kind: "status", text: "Removed from the council", at: 20 });
    expect(removed.findings.map((each) => each.title)).toEqual(["Alpha leak"]);
    expect(removed.findingsIssued).toBe(2);
  });

  test("the reviewer's positions go from every finding", () => {
    const review = deliberatingWithFailedR2();
    // The failed reviewer once took a stance on r1's finding.
    const withStance: Review = { ...review, findings: review.findings.map((each) => ({ ...each, positions: [...each.positions, { reviewerId: "r2", stance: "challenges", round: 1, at: 12 } as Review["findings"][number]["positions"][number]] })) };
    const removed = reduce(withStance, { type: "reviewer-removed", reviewerId: "r2", at: 20 });
    expect(removed.findings.flatMap((each) => each.positions).some((position) => position.reviewerId === "r2")).toBe(false);
    expect(removed.findings.flatMap((each) => each.positions).length).toBeGreaterThan(0);
  });

  test("in a later phase its findings stay", () => {
    const removed = reduce(deliberatingWithFailedR2(), { type: "reviewer-removed", reviewerId: "r2", at: 20 });
    expect(r2Of(removed).enabled).toBe(false);
    expect(removed.findings.map((each) => each.title)).toEqual(["Alpha leak", "Beta deadlock", "Gamma crash"]);
    expect(removed.findings.flatMap((each) => each.positions).some((position) => position.reviewerId === "r2")).toBe(false);
  });

  test("interrupted in the independent review drops its findings too; interrupted later keeps them", () => {
    const early = reduce(withFailedR2(), { type: "interrupted", at: 15 });
    expect(early.interruptedPhase).toBe("independent-review");
    expect(reduce(early, { type: "reviewer-removed", reviewerId: "r2", at: 20 }).findings.map((each) => each.title)).toEqual(["Alpha leak"]);
    const late = reduce(deliberatingWithFailedR2(), { type: "interrupted", at: 15 });
    expect(reduce(late, { type: "reviewer-removed", reviewerId: "r2", at: 20 }).findings).toHaveLength(3);
  });

  test("a failed reviewer can also be removed from an ended review", () => {
    const ended = play(deliberatingWithFailedR2(), [{ type: "concluded", at: 30, summary: "done" }]);
    expect(ended.phase).toBe("complete");
    expect(r2Of(reduce(ended, { type: "reviewer-removed", reviewerId: "r2", at: 31 })).enabled).toBe(false);
  });

  test("refused in the setup, for unknown or disabled reviewers, and for one that didn't fail", () => {
    expect(() => reduce(fresh(), { type: "reviewer-removed", reviewerId: "r2", at: 1 })).toThrow(ReviewError);
    const review = withFailedR2();
    expect(() => reduce(review, { type: "reviewer-removed", reviewerId: "r9", at: 20 })).toThrow("takes part");
    expect(() => reduce(review, { type: "reviewer-removed", reviewerId: "r1", at: 20 })).toThrow("hasn't failed");
    expect(() => reduce(review, { type: "reviewer-removed", reviewerId: "r3", at: 20 })).toThrow(ReviewError);
    const removed = reduce(review, { type: "reviewer-removed", reviewerId: "r2", at: 20 });
    expect(() => reduce(removed, { type: "reviewer-removed", reviewerId: "r2", at: 21 })).toThrow("takes part");
  });

  test("a resumed deliberation gives the removed reviewer no position, even on its own finding", () => {
    const removed = reduce(deliberatingWithFailedR2(), { type: "reviewer-removed", reviewerId: "r2", at: 20 });
    const resumed = play(removed, [{ type: "interrupted", at: 25 }, { type: "resumed", at: 26 }]);
    expect(resumed.phase).toBe("deliberation");
    const own = resumed.findings.find((each) => each.reviewerId === "r2")!;
    expect(own.title).toBe("Beta deadlock");
    expect(own.positions.some((position) => position.reviewerId === "r2")).toBe(false);
    expect(resumed.findings.find((each) => each.reviewerId === "r1")!.positions.map((position) => position.reviewerId)).toContain("r1");
  });

  test("the verdict names a failed reviewer, but not one removed before it", () => {
    const review = deliberatingWithFailedR2();
    expect(verdictSummary(review)).toContain("failed and took no part");
    expect(verdictSummary(reduce(review, { type: "reviewer-removed", reviewerId: "r2", at: 20 }))).not.toContain("took no part");
  });
});

describe("after a removal", () => {
  const mixed = () =>
    play(newReview("rev2", { ...setup, seats: ["profile:Home", "mock-claude", "mock-codex"].map((agent) => ({ agent, enabled: true })) }, "mixed", 0), [
      { type: "started", at: 1 },
      ...["r1", "r2", "r3"].map((reviewerId): ReviewEvent => ({ type: "reviewer-started", reviewerId, at: 2 })),
    ]);

  test("in the independent review, who ran the reviewers follows the seats left", () => {
    const review = play(mixed(), [finish("r1", "failed"), { type: "reviewer-removed", reviewerId: "r1", at: 20 }]);
    expect(review.runner).toBe("mock");
  });

  test("later it stays as it was, as the removed seat's findings stay", () => {
    const review = play(mixed(), [
      { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Alpha leak", "src/a.ts") },
      finish("r1"),
      finish("r2"),
      finish("r3"),
      { type: "deliberation-started", at: 11, rounds: 2 },
      { type: "round-started", at: 12, round: 1 },
      finish("r1", "failed"),
      { type: "reviewer-removed", reviewerId: "r1", at: 20 },
    ]);
    expect(review.runner).toBe("mixed");
  });

  test("a removed reporter has no say: the co-reporter's concession withdraws the finding", () => {
    let review = play(mixed(), [
      { type: "finding-reported", reviewerId: "r1", at: 3, finding: finding("Alpha leak", "src/a.ts") },
      { type: "finding-reported", reviewerId: "r2", at: 4, finding: finding("Alpha leak", "src/a.ts") },
      finish("r1"),
      finish("r2"),
      finish("r3"),
      { type: "findings-merged", at: 10, into: "F1", merged: ["F2"] },
      { type: "deliberation-started", at: 11, rounds: 2 },
      { type: "round-started", at: 12, round: 1 },
      finish("r1", "failed"),
      { type: "reviewer-removed", reviewerId: "r1", at: 20 },
      { type: "argued", reviewerId: "r2", at: 21, argument: { findingId: "F1", stance: "challenges", confidence: "high", text: "Not a leak after all.", evidence: [] } },
    ]);
    expect(settle(review, review.findings[0]!)).toMatchObject({ status: "withdrawn", rationale: "Claude withdrew it." });
    // With every reporter removed, the finding stands on the others' stances.
    review = play(review, [finish("r2", "failed"), { type: "reviewer-removed", reviewerId: "r2", at: 22 }]);
    expect(settle(review, review.findings[0]!).status).not.toBe("withdrawn");
  });
});

describe("ReviewSession.remove", () => {
  /** r1 and r3 review for 10 s; r2 reports a finding and fails at once. */
  function sessionWithFailingR2() {
    const clock = new FakeClock();
    const runner: ReviewerRunner = {
      async run(job, report, signal) {
        if (job.reviewer.id === "r2") {
          report({ type: "finding-reported", finding: finding("Beta deadlock", "src/b.ts") });
          throw new Error("agent crashed");
        }
        report({ type: "finding-reported", finding: finding(job.reviewer.id === "r1" ? "Alpha leak" : "Gamma crash", job.reviewer.id === "r1" ? "src/a.ts" : "src/c.ts") });
        await clock.sleep(10_000, signal);
      },
      async deliberate() {},
      async propose() {},
      async verify() {},
    };
    return { clock, session: new ReviewSession(fresh(), { runner, clock, onChange: () => {} }) };
  }

  test("removing a failed reviewer mid-review: the review goes on without it and concludes", async () => {
    const { clock, session } = sessionWithFailingR2();
    const done = session.run();
    await clock.settle();
    expect(r2Of(session.review)).toMatchObject({ status: "failed", problem: "agent crashed" });
    expect(session.review.findings.map((each) => each.title)).toContain("Beta deadlock");

    session.remove("r2");
    expect(r2Of(session.review).enabled).toBe(false);
    expect(session.review.findings.map((each) => each.title).sort()).toEqual(["Alpha leak", "Gamma crash"]);

    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.findings.map((each) => each.title).sort()).toEqual(["Alpha leak", "Gamma crash"]);
    expect(final.findings.every((each) => each.positions.every((position) => position.reviewerId !== "r2"))).toBe(true);
    expect(final.reviewers.filter((reviewer) => reviewer.enabled).map(({ id }) => id)).toEqual(["r1", "r3"]);
    expect(final.verdict?.summary).not.toContain("took no part");
  });

  test("a reviewer that didn't fail is refused", async () => {
    const { clock, session } = sessionWithFailingR2();
    const done = session.run();
    await clock.settle();
    expect(() => session.remove("r1")).toThrow(ReviewError);
    await clock.runAll();
    await done;
  });
});

describe("the remove action", () => {
  const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const answer = (profile: string, prompt: string) => {
    if (prompt.includes('"groups"')) return json({ groups: [] });
    if (prompt.includes('"proposals"')) return json({ proposals: [] });
    if (prompt.includes('"checks"')) return json({ checks: [] });
    if (prompt.includes('"arguments"')) return json({ arguments: [] });
    return json({ findings: [{ title: `${profile} finding`, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "README.md", line: 1 }] }] });
  };

  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), "spectra-remove-"));
    await writeFile(join(dir, "README.md"), "# A project\n");
    const clock = new FakeClock();
    let ids = 0;
    const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {} });
    const canvas = new FakeCanvas<Review>();
    const context = canvas.context();
    const answered = new Set<number>();
    /** Answers each started conversation (unless held); beta replies without JSON, so it fails. */
    async function drive(hold: (started: { profile: string }) => boolean = () => false) {
      for (let i = 0; i < 1_000; i++) {
        await clock.settle();
        const next = canvas.started.findIndex((started, index) => !answered.has(index) && !hold(started));
        if (next >= 0) {
          answered.add(next);
          const started = canvas.started[next]!;
          const text = started.profile === "beta" ? "I looked, it is fine." : answer(started.profile, started.prompt);
          await host.replied!({ id: `conversation-fixer-${next + 1}`, profile: started.profile }, { text, ended: "finished" }, context);
          continue;
        }
        if (canvas.started.some((started, index) => !answered.has(index) && hold(started))) return;
        if (!(await clock.step())) return;
      }
      throw new Error("The review never settled.");
    }
    await host.tools.council_open!.run({ target: dir, agents: ["profile:alpha", "profile:beta"] }, context);
    return { host, canvas, context, drive, clock, id: canvas.items[0]!.id };
  }

  test("on a running review it goes through the session: the review goes on and concludes without the reviewer", async () => {
    const { host, canvas, context, drive, id } = await boot();
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await drive((started) => started.profile === "alpha");
    expect(canvas.item(id).data.phase).toBe("independent-review");
    expect(canvas.item(id).data.reviewers[1]).toMatchObject({ status: "failed" });

    await expect(host.action!(canvas.item(id), { kind: "remove", reviewerId: "r1" }, context)).rejects.toThrow("hasn't failed");
    await host.action!(canvas.item(id), { kind: "remove", reviewerId: "r2" }, context);
    expect(canvas.item(id).data.reviewers[1]!.enabled).toBe(false);

    await drive();
    const review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.findings.map((each) => each.title)).toEqual(["alpha finding"]);
    expect(review.verdict?.summary).not.toContain("took no part");
  });

  test("on an ended review it changes the stored item; a reviewer that didn't fail throws the reason", async () => {
    const { host, canvas, context, drive, id } = await boot();
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await drive();
    const ended = canvas.item(id).data;
    expect(ended.phase).toBe("complete");
    expect(ended.reviewers[1]).toMatchObject({ status: "failed", enabled: true });
    expect(ended.verdict?.summary).toContain("failed and took no part");

    await expect(host.action!(canvas.item(id), { kind: "remove", reviewerId: "r1" }, context)).rejects.toThrow("hasn't failed");
    await host.action!(canvas.item(id), { kind: "remove", reviewerId: "r2" }, context);
    const after = canvas.item(id).data;
    expect(after.reviewers[1]).toMatchObject({ enabled: false });
    expect(after.reviewers[1]!.activity.at(-1)!.text).toBe("Removed from the council");
    await expect(host.action!(canvas.item(id), { kind: "remove", reviewerId: "r2" }, context)).rejects.toThrow("takes part");
  });
});
