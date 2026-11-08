import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPrompt } from "../core/agent-turns.ts";
import { DEPTH_PRESETS, depthOf, knobsText, overLimit, plannedTurns } from "../core/depth.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import { REVIEW_FORMAT, type Review } from "../core/model.ts";
import { MockRunner, mockScript } from "../core/mock-runner.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce, ReviewError, setupOf, upgradeReview } from "../core/review.ts";
import { setupPatchSchema, viewActionSchema, type FindingInput, type Setup } from "../core/schemas.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const seats3 = ["mock-claude", "mock-codex", "mock-gemini"].map((agent) => ({ agent, enabled: true }));
const setup = (extra: Partial<Setup> = {}): Setup => ({ target: "/repo", profile: "code", depth: "standard", instructions: "", seats: seats3, ...extra });
const fresh = (extra: Partial<Setup> = {}) => newReview("rev1", setup(extra), "mock", 0);

const finding = (title: string, severity: FindingInput["severity"] = "medium", confidence: FindingInput["confidence"] = "high"): FindingInput => ({
  title,
  summary: "Something is wrong.",
  severity,
  confidence,
  category: "correctness",
  evidence: [{ path: "src/a.ts", line: 3 }],
});

/** A review in the independent review with r1 reviewing and these findings reported by r1 (and r2 for `other`). */
function reviewing(maxFindings: number, mine: FindingInput[], other: FindingInput[] = []): Review {
  let review = reduce(fresh({ maxFindings }), { type: "started", at: 1 });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
  for (const each of mine) review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 3, finding: each });
  for (const each of other) review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 3, finding: each });
  return review;
}

describe("core/depth", () => {
  test("presets", () => {
    expect(DEPTH_PRESETS).toEqual({
      quick: { deliberationRounds: 2, maxFindings: 3 },
      standard: { deliberationRounds: 3, maxFindings: 6 },
      deep: { deliberationRounds: 4, maxFindings: 10 },
    });
  });

  test("depthOf gives the matching preset or custom", () => {
    for (const depth of ["quick", "standard", "deep"] as const) expect(depthOf(DEPTH_PRESETS[depth])).toBe(depth);
    expect(depthOf({ deliberationRounds: 3, maxFindings: 9 })).toBe("custom");
    expect(depthOf({ deliberationRounds: 2, maxFindings: 6 })).toBe("custom");
  });

  test("knobsText", () => {
    expect(knobsText({ deliberationRounds: 3, maxFindings: 6 })).toBe("3 rounds, at most 6 findings per reviewer");
    expect(knobsText({ deliberationRounds: 1, maxFindings: 1 })).toBe("1 round, at most 1 finding per reviewer");
  });

  test("plannedTurns", () => {
    const knobs = DEPTH_PRESETS.standard;
    expect(plannedTurns(3, knobs, false)).toEqual({ total: 3 + 9 + 3, review: 3, grouping: 0, rounds: 9, proposals: 3 });
    expect(plannedTurns(3, knobs, true)).toEqual({ total: 3 + 1 + 9 + 3, review: 3, grouping: 1, rounds: 9, proposals: 3 });
    expect(plannedTurns(1, knobs, true)).toEqual({ total: 1, review: 1, grouping: 0, rounds: 0, proposals: 0 });
    expect(plannedTurns(2, { deliberationRounds: 5, maxFindings: 1 }, false).rounds).toBe(10);
  });

  test("overLimit keeps the most severe, then more confident, then earliest", () => {
    const review = reviewing(2, [finding("a", "low", "high"), finding("b", "high", "low"), finding("c", "high", "high"), finding("d", "high", "low"), finding("e", "critical", "low")]);
    // F1 low, F2 high/low, F3 high/high, F4 high/low, F5 critical/low: keeps F5 and F3.
    expect(overLimit(review, "r1").sort()).toEqual(["F1", "F2", "F4"]);
    const ties = reviewing(2, [finding("a"), finding("b"), finding("c")]);
    expect(overLimit(ties, "r1")).toEqual(["F3"]);
    expect(overLimit(reviewing(3, [finding("a"), finding("b"), finding("c")]), "r1")).toEqual([]);
  });

  test("overLimit counts only the reviewer's own findings", () => {
    const review = reviewing(1, [finding("a")], [finding("x"), finding("y")]);
    expect(overLimit(review, "r1")).toEqual([]);
    expect(overLimit(review, "r2")).toEqual(["F3"]);
  });
});

describe("newReview and configured", () => {
  test("knobs come from the setup, else from the depth preset", () => {
    expect(fresh()).toMatchObject({ depth: "standard", deliberationRounds: 3, maxFindings: 6 });
    expect(fresh({ depth: "deep" })).toMatchObject({ depth: "deep", deliberationRounds: 4, maxFindings: 10 });
    expect(fresh({ deliberationRounds: 5 })).toMatchObject({ depth: "custom", deliberationRounds: 5, maxFindings: 6 });
    expect(fresh({ depth: "standard", maxFindings: 9 })).toMatchObject({ depth: "custom", deliberationRounds: 3, maxFindings: 9 });
    expect(fresh({ depth: "quick", deliberationRounds: 3, maxFindings: 6 }).depth).toBe("standard");
  });

  test("a depth patch sets both knobs", () => {
    const review = reduce(fresh({ maxFindings: 9 }), { type: "configured", patch: { depth: "deep" } });
    expect(review).toMatchObject({ depth: "deep", deliberationRounds: 4, maxFindings: 10 });
  });

  test("a knob in the same patch wins over the preset", () => {
    const review = reduce(fresh(), { type: "configured", patch: { depth: "quick", maxFindings: 8 } });
    expect(review).toMatchObject({ depth: "custom", deliberationRounds: 2, maxFindings: 8 });
  });

  test("a knob alone makes it custom, and matching values bring the preset back", () => {
    const custom = reduce(fresh(), { type: "configured", patch: { deliberationRounds: 5 } });
    expect(custom).toMatchObject({ depth: "custom", deliberationRounds: 5, maxFindings: 6 });
    const back = reduce(custom, { type: "configured", patch: { deliberationRounds: 3 } });
    expect(back).toMatchObject({ depth: "standard", deliberationRounds: 3, maxFindings: 6 });
  });

  test("setupOf returns depth and both knobs", () => {
    const state = setupOf(fresh({ maxFindings: 9 }));
    expect(state).toMatchObject({ depth: "custom", deliberationRounds: 3, maxFindings: 9 });
  });
});

describe("schemas", () => {
  test("setupPatchSchema and viewActionSchema refuse knobs out of range", () => {
    for (const patch of [{ deliberationRounds: 0 }, { deliberationRounds: 7 }, { maxFindings: 0 }, { maxFindings: 21 }, { deliberationRounds: 1.5 }, { maxFindings: 2.5 }]) {
      expect(setupPatchSchema.safeParse(patch).success).toBe(false);
      expect(viewActionSchema.safeParse({ kind: "configure", patch }).success).toBe(false);
    }
    for (const patch of [{ deliberationRounds: 1, maxFindings: 20 }, { deliberationRounds: 6, maxFindings: 1 }]) {
      expect(setupPatchSchema.safeParse(patch).success).toBe(true);
      expect(viewActionSchema.safeParse({ kind: "configure", patch }).success).toBe(true);
    }
  });
});

describe("upgradeReview", () => {
  const stored = (extra: Record<string, unknown>) => {
    const { deliberationRounds: _r, maxFindings: _m, ...rest } = fresh({ depth: "deep" });
    return { ...rest, format: 7, ...extra } as unknown as Review;
  };

  test("the format is 8", () => {
    expect(REVIEW_FORMAT).toBe(8);
  });

  test("a format 7 review gets its depth preset's knobs", () => {
    const upgraded = upgradeReview(stored({}));
    expect(upgraded).toMatchObject({ format: 8, depth: "deep", deliberationRounds: 4, maxFindings: 10 });
    expect(upgradeReview(stored({ depth: "quick" }))).toMatchObject({ deliberationRounds: 2, maxFindings: 3 });
  });

  test("one that had started deliberating keeps its rounds", () => {
    expect(upgradeReview(stored({ depth: "standard", rounds: 2 }))).toMatchObject({ deliberationRounds: 2, maxFindings: 6 });
  });
});

describe("engine", () => {
  test("a resumed review caps a reviewer that finished before the limit applied", async () => {
    let review = reviewing(2, [finding("a", "low"), finding("b", "critical"), finding("c", "medium"), finding("d", "high"), finding("e", "info")]);
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" });
    review = reduce(review, { type: "interrupted", at: 5 });
    const clock = new FakeClock();
    const quiet: ReviewerRunner = { run: async () => {}, deliberate: async () => {}, propose: async () => {}, verify: async () => {} };
    const done = new ReviewSession(review, { runner: quiet, clock, onChange: () => {} }).resume();
    await clock.runAll();
    const final = await done;
    expect(final.findings.filter((each) => each.reviewerId === "r1").map((each) => each.title)).toEqual(["b", "d"]);
    expect(final.reviewers[0]!.activity.some((each) => each.text.startsWith("Kept its 2 most severe findings; dropped"))).toBe(true);
  });

  test("deliberation runs review.deliberationRounds rounds", async () => {
    for (const rounds of [1, 5]) {
      const clock = new FakeClock();
      const review = reduce(fresh(), { type: "configured", patch: { deliberationRounds: rounds } });
      const done = new ReviewSession(review, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} }).run();
      await clock.runAll();
      const final = await done;
      expect(final.phase).toBe("complete");
      expect(final).toMatchObject({ rounds, round: rounds });
      expect(new Set(final.arguments.map((each) => each.round)).size).toBeLessThanOrEqual(rounds);
      expect(Math.max(0, ...final.arguments.map((each) => each.round))).toBeLessThanOrEqual(rounds);
    }
  });

  test("a reviewer past maxFindings keeps its most severe, and the cap is noted", async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    const severities = ["low", "critical", "info", "high", "medium"] as const;
    const runner: ReviewerRunner = {
      async run(job, report) {
        if (job.reviewer.id !== "r1") return;
        severities.forEach((severity, index) => report({ type: "finding-reported", finding: finding(`Problem ${index}`, severity) }));
      },
      async deliberate() {},
      async propose() {},
      async verify() {},
    };
    const session = new ReviewSession(fresh({ maxFindings: 2 }), {
      runner,
      clock,
      onChange: (next) => {
        for (const reviewer of next.reviewers) seen.push(next.findings.filter((each) => each.reviewerId === reviewer.id).length);
      },
    });
    const done = session.run();
    await clock.runAll();
    const final = await done;
    const own = final.findings.filter((each) => each.reviewerId === "r1");
    expect(own.map((each) => each.severity).sort()).toEqual(["critical", "high"]);
    expect(final.reviewers[0]!.activity.some((each) => each.kind === "note" && each.text.startsWith("Kept its 2 most severe findings; dropped"))).toBe(true);
    // The cap lands as soon as the run ends, before anything else sees more than 5; none ever exceeds the report itself.
    expect(Math.max(...seen)).toBeLessThanOrEqual(5);
    expect(final.findings.length).toBeLessThanOrEqual(2);
  });

  test("findings-capped is refused outside the independent review and for another reviewer's finding", () => {
    const review = reviewing(1, [finding("a"), finding("b")], [finding("x")]);
    expect(() => reduce(review, { type: "findings-capped", reviewerId: "r1", at: 4, findingIds: ["F3"] })).toThrow(ReviewError);
    const capped = reduce(review, { type: "findings-capped", reviewerId: "r1", at: 4, findingIds: ["F2"] });
    expect(capped.findings.map((each) => each.id)).toEqual(["F1", "F3"]);
    expect(() => reduce({ ...review, phase: "deliberation" }, { type: "findings-capped", reviewerId: "r1", at: 4, findingIds: ["F2"] })).toThrow("independent review");
  });

  test("the turns a mock review takes match the plan", async () => {
    const clock = new FakeClock();
    const inner = new MockRunner(async () => FILES, clock);
    const counts = { run: 0, deliberate: 0, propose: 0, group: 0 };
    const runner: ReviewerRunner = {
      run: (job, report, signal) => (counts.run++, inner.run(job, report, signal)),
      deliberate: (job, report, signal) => (counts.deliberate++, inner.deliberate(job, report, signal)),
      propose: (job, report, signal) => (counts.propose++, inner.propose(job, report, signal)),
      verify: (job, report, signal) => inner.verify(job, report, signal),
      group: async () => void counts.group++,
    };
    // A mock runner has no grouping turn, so the wrapper is given none either.
    delete runner.group;
    const review = fresh();
    const done = new ReviewSession(review, { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    const final = await done;
    expect(final.phase).toBe("complete");
    const plan = plannedTurns(3, review, false);
    expect(counts.group).toBe(0);
    expect(counts.run).toBe(3);
    expect(counts.deliberate).toBe(3 * review.deliberationRounds);
    expect(counts.run + counts.deliberate).toBe(plan.review + plan.rounds);
    expect(counts.propose).toBeLessThanOrEqual(plan.proposals);
    expect(counts.run + counts.deliberate + counts.propose).toBeLessThanOrEqual(plan.total);
  });
});

describe("mock plans", () => {
  const reports = (review: Review, index: number) =>
    mockScript({ review, reviewer: review.reviewers[index]!, profile: PROFILES.code }, FILES).filter(({ report }) => report.type === "finding-reported").length;

  test("no mock reports more than maxFindings, for each preset", () => {
    for (const depth of ["quick", "standard", "deep"] as const) {
      const review = fresh({ depth });
      for (let index = 0; index < 3; index++) {
        const count = reports(review, index);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(review.maxFindings);
      }
    }
  });

  test("with maxFindings 1 every mock reports exactly 1", () => {
    const review = fresh({ maxFindings: 1 });
    for (let index = 0; index < 3; index++) expect(reports(review, index)).toBe(1);
  });
});

describe("reviewPrompt", () => {
  test("states the limit and no longer names the depth", () => {
    const review = fresh();
    const prompt = reviewPrompt({ review, reviewer: review.reviewers[0]!, profile: PROFILES.code });
    expect(prompt).toContain("Report at most 6 findings");
    expect(prompt).not.toContain("Standard depth");
  });
});

describe("host", () => {
  const target = async () => {
    const dir = await mkdtemp(join(tmpdir(), "spectra-depth-"));
    await writeFile(join(dir, "README.md"), "# A project\n");
    return dir;
  };
  const make = () => {
    let ids = 0;
    const clock = new FakeClock();
    const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {} });
    const canvas = new FakeCanvas<Review>();
    return { host, canvas, context: canvas.context() };
  };

  test("council_open takes rounds over the depth preset, and says so", async () => {
    const { host, canvas, context } = make();
    const answer = await host.tools.council_open!.run({ target: await target(), agents: ["mock-claude", "mock-codex"], depth: "quick", rounds: 5 }, context);
    expect(canvas.items[0]!.data).toMatchObject({ deliberationRounds: 5, maxFindings: 3, depth: "custom" });
    expect(answer).toContain("5 rounds, at most 3 findings per reviewer");
  });

  test("council_open refuses rounds out of range", async () => {
    const { host, canvas, context } = make();
    await expect(Promise.resolve().then(() => host.tools.council_open!.run({ target: "/x", agents: ["mock-claude"], rounds: 7 }, context))).rejects.toThrow();
    expect(canvas.items).toHaveLength(0);
  });

  test("rerun of an ended custom review prompts with the knobs and no depth", async () => {
    const { host, canvas, context } = make();
    await host.tools.council_open!.run({ target: await target(), agents: ["mock-claude", "mock-codex"], depth: "quick", rounds: 5 }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await host.action!(canvas.items[0]!, { kind: "stop" }, context);
    await host.action!(canvas.items[0]!, { kind: "rerun" }, context);
    const prompt = canvas.prompts.at(-1)!;
    const open = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));
    expect(open).toMatchObject({ rounds: 5, maxFindings: 3 });
    expect(open).not.toHaveProperty("depth");
  });
});
