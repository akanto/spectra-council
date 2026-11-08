import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import { isStanding, type Review } from "../core/model.ts";
import { MockRunner, mockScript } from "../core/mock-runner.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce } from "../core/review.ts";
import { findingInputSchema } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const review = (depth: "quick" | "standard" | "deep" = "standard", profile: "code" | "architecture" = "architecture") =>
  newReview("rev1", { target: "/repo", profile, depth, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent, index) => ({ agent, enabled: index < 2 })) }, "mock", 0);

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
      async propose() {},
      async verify() {},
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
      propose: (job, report, signal) => mock.propose(job, report, signal),
      verify: (job, report, signal) => mock.verify(job, report, signal),
    };
    const done = new ReviewSession(fourReviewers(), { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.reviewers[1]).toMatchObject({ status: "failed", problem: "lost the thread" });
    expect(final.verdict).not.toBeNull();
    expect(final.findings.every((finding) => finding.status !== "reported")).toBe(true);
  });

  /** Two reviewers: r1 reports one finding; in the deliberation each does what `turn` says for its round, or throws. */
  async function twoReviewerRun(turn: (reviewerId: string, round: number) => { stance: "supports" | "challenges" | "uncertain"; text: string } | "fail" | null) {
    const clock = new FakeClock();
    const runner: ReviewerRunner = {
      async run(job, report) {
        if (job.reviewer.id === "r1") report({ type: "finding-reported", finding: { title: "Off by one", summary: "Drops the last element.", severity: "high", confidence: "high", category: "correctness", evidence: [{ path: "src/engine.ts", line: 3 }] } });
      },
      async deliberate(job, report) {
        const move = turn(job.reviewer.id, job.round);
        if (move === "fail") throw new Error("Timed out");
        if (move) report({ type: "argued", argument: { findingId: "F1", confidence: "high", evidence: [], ...move } });
      },
      async propose() {},
      async verify() {},
    };
    const done = new ReviewSession(review(), { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    return done;
  }

  test("a challenger that times out in a later round leaves the finding disputed, its challenge unanswered", async () => {
    const final = await twoReviewerRun((reviewerId, round) => (reviewerId !== "r2" ? null : round === 1 ? { stance: "challenges", text: "Not reachable: the caller trims the list first." } : "fail"));
    expect(final.phase).toBe("complete");
    expect(final.reviewers[1]).toMatchObject({ status: "failed", problem: "Timed out" });
    const finding = final.findings[0]!;
    expect(finding.status).toBe("disputed");
    expect(finding.resolution).toMatchObject({
      rationale: "1 of 2 back it; Codex's challenge stands; Codex couldn't continue, so its last stance counts.",
      dissenters: ["r2"],
      dissent: [{ reviewerId: "r2", reason: "Not reachable: the caller trims the list first.", argumentId: "A1" }],
    });
    expect(finding.resolution!.rationale).not.toContain("answered");
    expect(final.verdict?.summary).toBe("1 finding: 1 disputed. No serious finding is agreed or confirmed. 1 serious finding is disputed. Codex failed and couldn't continue.");
  });

  test("a finding nobody backs after its reporter fails stays reported, and the verdict counts it unsettled", async () => {
    const final = await twoReviewerRun((reviewerId) => (reviewerId === "r1" ? "fail" : { stance: "uncertain", text: "I can't tell from the code." }));
    expect(final.phase).toBe("complete");
    const finding = final.findings[0]!;
    expect(finding).toMatchObject({ status: "reported", resolution: null, proposal: null });
    expect(final.verdict?.summary).toBe("1 finding: 1 unsettled. No serious finding stands. 1 finding was left unsettled, with no one backing it. Claude failed and couldn't continue.");
  });

  async function completeRun() {
    const clock = new FakeClock();
    const done = new ReviewSession(fourReviewers(), { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} }).run();
    await clock.runAll();
    return done;
  }

  /** A complete review whose standing findings were accepted, handed off and reported fixed. */
  function fixedReview(base: Review): Review {
    let current = base;
    const apply = (event: Parameters<typeof reduce>[1]) => void (current = reduce(current, event));
    const ids = base.findings.filter(isStanding).map((finding) => finding.id);
    for (const findingId of ids) apply({ type: "ruled", at: 5_000_000, findingId, decision: "accepted", note: "" });
    apply({ type: "handoff-written", at: 5_000_001, path: "/tmp/handoff.md", findingIds: ids });
    apply({ type: "fix-requested", at: 5_000_002, findingIds: ids });
    for (const findingId of ids) apply({ type: "fix-reported", at: 5_000_003, findingId, summary: `Fixed ${findingId}.`, files: ["src/engine.ts"] });
    return current;
  }

  test("every standing finding gets a proposal from its reporter, and withdrawn ones none", async () => {
    const final = await completeRun();
    expect(final.findings.some(isStanding)).toBe(true);
    for (const finding of final.findings) {
      if (isStanding(finding)) expect(finding.proposal).toMatchObject({ drafterId: finding.reviewerId });
      else expect(finding.proposal).toBeNull();
    }
  });

  test("a verification round checks every fixed finding, by its reporter and backers only", async () => {
    const final = await completeRun();
    const fixed = fixedReview(final);
    const clock = new FakeClock();
    const session = new ReviewSession(fixed, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.verify();
    await clock.runAll();
    const after = await done;
    expect(after.phase).toBe("complete");
    expect(after.verifications).toBe(1);
    const fixes = after.findings.flatMap((finding) => (finding.fix ? [{ finding, fix: finding.fix }] : []));
    expect(fixes.length).toBeGreaterThan(0);
    for (const { finding, fix } of fixes) {
      expect(["verified", "reopened"]).toContain(fix.state);
      expect(fix.checks.length).toBeGreaterThan(0);
      const allowed = new Set([finding.reviewerId, ...finding.positions.filter((position) => position.stance === "supports").map((position) => position.reviewerId)]);
      for (const check of fix.checks) expect(allowed.has(check.reviewerId)).toBe(true);
    }
  });

  test("stopping a verification leaves the fixes fixed and the review complete", async () => {
    const fixed = fixedReview(await completeRun());
    const clock = new FakeClock();
    const session = new ReviewSession(fixed, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} });
    const done = session.verify();
    await clock.step();
    await clock.step();
    session.stop();
    const after = await done;
    expect(after.phase).toBe("complete");
    expect(after.findings.flatMap((finding) => (finding.fix ? [finding.fix.state] : [])).every((state) => state === "fixed")).toBe(true);
  });

  test("a propose that throws leaves an error activity, and the review still concludes", async () => {
    const clock = new FakeClock();
    const mock = new MockRunner(async () => FILES, clock);
    const runner: ReviewerRunner = {
      run: (job, report, signal) => mock.run(job, report, signal),
      deliberate: (job, report, signal) => mock.deliberate(job, report, signal),
      async propose(job, report, signal) {
        if (job.reviewer.id === "r1") throw new Error("no ideas");
        await mock.propose(job, report, signal);
      },
      verify: (job, report, signal) => mock.verify(job, report, signal),
    };
    const done = new ReviewSession(fourReviewers(), { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    expect(final.verdict).not.toBeNull();
    expect(final.reviewers[0]!.activity.some((each) => each.kind === "error" && each.text.includes("no ideas"))).toBe(true);
  });
});
