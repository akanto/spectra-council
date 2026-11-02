import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { MockRunner, mockScript } from "../core/mock-runner.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview } from "../core/review.ts";
import { findingInputSchema } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const review = (depth: "quick" | "standard" | "deep" = "standard", profile: "code" | "architecture" = "architecture") =>
  newReview("rev1", { target: "/repo", profile, depth, instructions: "", seats: defaultSeats() }, "mock", 0);

describe("mockScript", () => {
  test("is the same for the same agent, profile, depth and files", () => {
    const base = review();
    const job = { review: base, reviewer: base.reviewers[0]!, profile: PROFILES.architecture };
    expect(mockScript(job, FILES)).toEqual(mockScript(job, FILES));
  });

  test("differs between personas, reads real files, and reports valid findings against files it read", () => {
    const base = review("deep");
    const scripts = base.reviewers.map((reviewer) => mockScript({ review: base, reviewer, profile: PROFILES.architecture }, FILES));
    expect(new Set(scripts.map((script) => JSON.stringify(script))).size).toBe(4);
    for (const script of scripts) {
      const read = script.flatMap(({ report }) => (report.type === "activity" && report.kind === "read" && report.path ? [report.path] : []));
      expect(read.every((path) => FILES.includes(path))).toBe(true);
      const findings = script.flatMap(({ report }) => (report.type === "finding-reported" ? [report.finding] : []));
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        const parsed = findingInputSchema.parse(finding);
        expect(read).toContain(parsed.evidence[0]!.path);
      }
    }
  });

  test("the codex persona reads source files first, the gemini persona docs", () => {
    const base = review("quick");
    const firstRead = (index: number) =>
      mockScript({ review: base, reviewer: base.reviewers[index]!, profile: PROFILES.architecture }, FILES).find(({ report }) => report.type === "activity" && report.kind === "read")!.report;
    expect(firstRead(1)).toMatchObject({ path: "src/engine.ts" });
    expect(firstRead(2)).toMatchObject({ path: "README.md" });
  });

  test("a single-file target still gets a finding", () => {
    const base = review("quick");
    const script = mockScript({ review: base, reviewer: base.reviewers[0]!, profile: PROFILES.architecture }, ["paper.tex"]);
    expect(script.filter(({ report }) => report.type === "finding-reported")).toHaveLength(1);
  });
});

describe("ReviewSession", () => {
  test("runs two mock reviewers concurrently to completion", async () => {
    const clock = new FakeClock();
    const changes: Review[] = [];
    const session = new ReviewSession(review(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: (next) => changes.push(next) });
    const done = session.run();
    // Both reviewers are at work before either finishes.
    await clock.step();
    await clock.step();
    expect(session.review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["reviewing", "reviewing"]);
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["completed", "completed"]);
    expect(final.reviewers.slice(2).map((reviewer) => reviewer.status)).toEqual(["idle", "idle"]);
    expect(final.verdict).not.toBeNull();
    expect(final.findings.every((finding) => finding.status !== "reported")).toBe(true);
    expect(final.findings.length).toBeGreaterThanOrEqual(4);
    expect(new Set(final.findings.map((finding) => finding.reviewerId))).toEqual(new Set(["r1", "r2"]));
    expect(changes.at(-1)).toBe(final);
    // Interleaved: the findings don't all come from one reviewer before the other's.
    const order = final.findings.map((finding) => finding.reviewerId).join("");
    expect(order).not.toMatch(/^r1+r2+$|^r2+r1+$/);
  });

  test("the same review twice gives the same findings", async () => {
    const play = async () => {
      const clock = new FakeClock();
      const session = new ReviewSession(review(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
      const done = session.run();
      await clock.runAll();
      return (await done).findings;
    };
    expect(await play()).toEqual(await play());
  });

  test("stop ends the review as stopped", async () => {
    const clock = new FakeClock();
    const session = new ReviewSession(review(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.run();
    for (let i = 0; i < 5; i++) await clock.step();
    session.stop();
    const final = await done;
    expect(final.phase).toBe("stopped");
    expect(final.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped"]);
  });

  test("a runner that throws fails its reviewer only, and a malformed finding is refused", async () => {
    const clock = new FakeClock();
    const runner: ReviewerRunner = {
      async run(job, report) {
        if (job.reviewer.id === "r1") throw new Error("agent crashed");
        report({ type: "finding-reported", finding: { title: "no evidence" } });
      },
      async deliberate() {},
    };
    const final = await new ReviewSession(review(), { runner, clock, onChange: () => {} }).run();
    expect(final.phase).toBe("complete");
    expect(final.reviewers[0]).toMatchObject({ status: "failed", problem: "agent crashed" });
    expect(final.reviewers[1]!.status).toBe("completed");
    expect(final.findings).toHaveLength(0);
    expect(final.reviewers[1]!.activity.at(-1)).toMatchObject({ kind: "error" });
  });

  const fourSeats = () => ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: true }));
  const fourReviewers = () => newReview("rev4", { target: "/repo", profile: "architecture", depth: "standard", instructions: "", seats: fourSeats() }, "mock", 0);

  test("a full four-reviewer standard run goes through deliberation to a verdict with every finding resolved", async () => {
    const clock = new FakeClock();
    const phases: string[] = [];
    const session = new ReviewSession(fourReviewers(), {
      runner: new MockRunner(async () => FILES, clock),
      clock,
      onChange: (next) => {
        if (phases.at(-1) !== next.phase) phases.push(next.phase);
      },
    });
    const done = session.run();
    await clock.runAll();
    const final = await done;
    expect(phases).toEqual(["independent-review", "deliberation", "synthesis", "complete"]);
    expect(final.rounds).toBe(3);
    expect(final.arguments.length).toBeGreaterThan(0);
    expect(final.findings.length).toBeGreaterThan(0);
    expect(final.findings.every((finding) => finding.status !== "reported" && finding.resolution !== null)).toBe(true);
    expect(final.verdict?.summary).toContain("finding");
  });

  test("stopping during the deliberation ends the review as stopped", async () => {
    const clock = new FakeClock();
    const session = new ReviewSession(fourReviewers(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.run();
    for (let i = 0; i < 2000 && session.review.phase !== "deliberation"; i++) await clock.step();
    expect(session.review.phase).toBe("deliberation");
    for (let i = 0; i < 3; i++) await clock.step();
    session.stop();
    const final = await done;
    expect(final.phase).toBe("stopped");
    expect(final.verdict).toBeNull();
  });

  test("with one seated reviewer there is no deliberation", async () => {
    const clock = new FakeClock();
    const seats = [{ agent: "mock-claude", enabled: true }, ...["mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: false }))];
    const solo = newReview("rev1", { target: "/repo", profile: "code", depth: "standard", instructions: "", seats }, "mock", 0);
    const session = new ReviewSession(solo, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.run();
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.rounds).toBe(0);
    expect(final.arguments).toHaveLength(0);
    expect(final.findings.length).toBeGreaterThan(0);
    expect(final.findings.every((finding) => finding.status === "reported")).toBe(true);
    expect(final.verdict?.summary).toContain("not deliberated");
  });

  test("a runner whose deliberate throws fails that reviewer, but the review still concludes", async () => {
    const clock = new FakeClock();
    const mock = new MockRunner(async () => FILES, clock);
    const runner: ReviewerRunner = {
      run: (job, report, signal) => mock.run(job, report, signal),
      async deliberate(job, report, signal) {
        if (job.reviewer.id === "r2") throw new Error("lost the thread");
        await mock.deliberate(job, report, signal);
      },
    };
    const done = new ReviewSession(fourReviewers(), { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.reviewers[1]).toMatchObject({ status: "failed", problem: "lost the thread" });
    expect(final.verdict).not.toBeNull();
    expect(final.findings.every((finding) => finding.status !== "reported")).toBe(true);
  });
});
