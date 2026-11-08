import { describe, expect, test } from "bun:test";
import { duplicateGroups, possibleDuplicates, sameProblem, titleKey } from "../core/duplicates.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import type { Finding, Review } from "../core/model.ts";
import { MockRunner } from "../core/mock-runner.ts";
import { newReview, reduce, ReviewError } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].map((agent) => ({ agent, enabled: true })) };

const input = (patch: Partial<FindingInput> = {}): FindingInput => ({
  title: "Off by one",
  summary: "The loop drops the last element.",
  severity: "medium",
  confidence: "high",
  category: "correctness",
  evidence: [{ path: "src/a.ts", line: 3 }],
  ...patch,
});

/** A finding as the reducer would hold it, for the pure functions. */
const finding = (id: string, patch: Partial<Finding> = {}): Finding => ({
  ...input(),
  id,
  reviewerId: "r1",
  status: "reported",
  reportedAt: 0,
  positions: [],
  resolution: null,
  proposal: null,
  ruling: null,
  alsoReported: [],
  fix: null,
  ...patch,
});

const withFindings = (findings: Finding[], args: Review["arguments"] = []): Review => ({ ...newReview("rev1", setup, "mock", 0), findings, arguments: args });

describe("titleKey", () => {
  test("ignores case and punctuation", () => {
    expect(titleKey("  Off-by-one: in the LOOP!  ")).toBe("off by one in the loop");
    expect(titleKey("Off by one")).toBe(titleKey("OFF BY ONE."));
  });
});

describe("sameProblem", () => {
  test("the same title is the same problem in the same file, whatever the category or line", () => {
    const first = finding("F1", { title: "Race in cache!" });
    const path = first.evidence[0]!.path;
    expect(sameProblem(first, finding("F2", { title: "race in cache", category: "other", evidence: [{ path, line: 90 }] }))).toBe(true);
  });

  test("the same generic title in different files is not the same problem", () => {
    expect(sameProblem(finding("F1", { title: "Silent error swallowing", evidence: [{ path: "src/server.ts", line: 4 }] }), finding("F2", { title: "Silent error swallowing", evidence: [{ path: "src/engine.ts", line: 4 }] }))).toBe(false);
  });

  test("same category, nearby lines and mostly shared words is the same problem", () => {
    const a = finding("F1", { title: "Unchecked path traversal in upload", evidence: [{ path: "src/a.ts", line: 10 }] });
    const b = finding("F2", { title: "Path traversal in upload handler", evidence: [{ path: "src/a.ts", line: 13 }] });
    expect(sameProblem(a, b)).toBe(true);
    expect(sameProblem(b, a)).toBe(true);
  });

  test("a range counts by its end, and four lines apart is too far", () => {
    const a = finding("F1", { title: "Unchecked path traversal in upload", evidence: [{ path: "src/a.ts", line: 10, endLine: 20 }] });
    const near = finding("F2", { title: "Path traversal in upload handler", evidence: [{ path: "src/a.ts", line: 23 }] });
    const far = finding("F3", { title: "Path traversal in upload handler", evidence: [{ path: "src/a.ts", line: 24 }] });
    expect(sameProblem(a, near)).toBe(true);
    expect(sameProblem(a, far)).toBe(false);
  });

  test("a different path, category or too few shared words is a different problem", () => {
    const a = finding("F1", { title: "Unchecked path traversal in upload", evidence: [{ path: "src/a.ts", line: 10 }] });
    expect(sameProblem(a, finding("F2", { title: "Path traversal in upload handler", evidence: [{ path: "src/b.ts", line: 10 }] }))).toBe(false);
    expect(sameProblem(a, finding("F3", { title: "Path traversal in upload handler", category: "security", evidence: [{ path: "src/a.ts", line: 10 }] }))).toBe(false);
  });

  test("two different problems on one line with unrelated titles don't merge", () => {
    const a = finding("F1", { title: "Off by one in pagination", evidence: [{ path: "src/a.ts", line: 5 }] });
    const b = finding("F2", { title: "Secrets logged verbosely", evidence: [{ path: "src/a.ts", line: 5 }] });
    expect(sameProblem(a, b)).toBe(false);
    expect(duplicateGroups(withFindings([a, b]))).toEqual([]);
  });

  test("findings without evidence only match by title", () => {
    const a = finding("F1", { title: "Unchecked path traversal in upload", evidence: [] });
    const b = finding("F2", { title: "Path traversal in upload handler", evidence: [] });
    expect(sameProblem(a, b)).toBe(false);
  });
});

describe("duplicateGroups", () => {
  test("keeps the most severe finding, the earliest among equals", () => {
    const review = withFindings([
      finding("F1", { title: "Race", severity: "low" }),
      finding("F2", { title: "race", severity: "high" }),
      finding("F3", { title: "RACE!", severity: "high" }),
      finding("F4", { title: "Unrelated thing" }),
    ]);
    expect(duplicateGroups(review)).toEqual([{ into: "F2", merged: ["F1", "F3"] }]);
  });

  test("groups transitively: A~B and B~C group all three", () => {
    const a = finding("F1", { title: "Unchecked path traversal upload", evidence: [{ path: "src/a.ts", line: 10 }] });
    const b = finding("F2", { title: "Unchecked path traversal upload", evidence: [{ path: "src/a.ts", line: 50 }] });
    const c = finding("F3", { title: "Path traversal upload handler", evidence: [{ path: "src/a.ts", line: 52 }] });
    expect(sameProblem(a, c)).toBe(false);
    expect(duplicateGroups(withFindings([a, b, c]))).toEqual([{ into: "F1", merged: ["F2", "F3"] }]);
  });

  test("no duplicates, no groups; separate groups stay separate", () => {
    expect(duplicateGroups(withFindings([finding("F1", { title: "A one" }), finding("F2", { title: "B two" })]))).toEqual([]);
    const groups = duplicateGroups(withFindings([finding("F1", { title: "Alpha" }), finding("F2", { title: "Beta" }), finding("F3", { title: "alpha" }), finding("F4", { title: "beta" })]));
    expect(groups).toEqual([
      { into: "F1", merged: ["F3"] },
      { into: "F2", merged: ["F4"] },
    ]);
  });
});

describe("possibleDuplicates", () => {
  const argument = (findingId: string, text: string): Review["arguments"][number] => ({ id: "A1", findingId, reviewerId: "r2", round: 1, stance: "supports", confidence: "high", text, evidence: [], at: 0 });

  test("same title, and symmetric through an argument that names the other as the same", () => {
    const f1 = finding("F1", { title: "Alpha issue" });
    const f2 = finding("F2", { title: "Beta issue" });
    const f3 = finding("F3", { title: "alpha issue!" });
    const review = withFindings([f1, f2, f3], [argument("F2", "I found the same independently in F1.")]);
    expect(possibleDuplicates(review, f2).map(({ id }) => id)).toEqual(["F1"]);
    expect(possibleDuplicates(review, f1).map(({ id }) => id)).toEqual(["F2", "F3"]);
    expect(possibleDuplicates(review, f3).map(({ id }) => id)).toEqual(["F1"]);
  });

  test("an argument must say same, duplicate, identical or again", () => {
    const f1 = finding("F1", { title: "Alpha" });
    const f2 = finding("F2", { title: "Beta" });
    expect(possibleDuplicates(withFindings([f1, f2], [argument("F2", "See F1 for context.")]), f2)).toEqual([]);
    for (const word of ["same", "a duplicate of", "identical to", "F1 again"]) {
      expect(possibleDuplicates(withFindings([f1, f2], [argument("F2", `This is ${word} F1.`)]), f2).map(({ id }) => id)).toEqual(["F1"]);
    }
  });

  test("a finding is not its own duplicate", () => {
    const f1 = finding("F1");
    expect(possibleDuplicates(withFindings([f1], [argument("F1", "the same as F1")]), f1)).toEqual([]);
  });
});

describe("findings-merged", () => {
  /** r1 and r2 report; r3 is seated but not yet finished unless `finish` says so. */
  function reviewed(reports: [string, FindingInput][], finish = true): Review {
    let review = reduce(newReview("rev1", setup, "mock", 0), { type: "started", at: 1 });
    for (const reviewerId of ["r1", "r2", "r3"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
    reports.forEach(([reviewerId, finding], index) => (review = reduce(review, { type: "finding-reported", reviewerId, at: 3 + index, finding })));
    if (finish) for (const reviewerId of ["r1", "r2", "r3"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" });
    return review;
  }

  test("folds the others into one, with the highest severity, their reports and the evidence once", () => {
    const review = reviewed([
      ["r1", input({ severity: "low", evidence: [{ path: "src/a.ts", line: 3 }] })],
      ["r2", input({ severity: "high", title: "off by one", evidence: [{ path: "src/a.ts", line: 3 }, { path: "src/b.ts", line: 1, endLine: 4 }] })],
      ["r3", input({ title: "Other", severity: "info" })],
    ]);
    const merged = reduce(review, { type: "findings-merged", at: 30, into: "F1", merged: ["F2"] });
    expect(merged.findings.map(({ id }) => id)).toEqual(["F1", "F3"]);
    const into = merged.findings[0]!;
    expect(into.severity).toBe("high");
    expect(into.evidence).toEqual([{ path: "src/a.ts", line: 3 }, { path: "src/b.ts", line: 1, endLine: 4 }]);
    expect(into.alsoReported).toEqual([{ reviewerId: "r2", findingId: "F2", title: "off by one", severity: "high", evidence: [{ path: "src/a.ts", line: 3 }, { path: "src/b.ts", line: 1, endLine: 4 }] }]);
    expect(merged.findingsIssued).toBe(3);
  });

  test("carries over the merged finding's own co-reports, and later ids are never reused", () => {
    let review = reviewed([
      ["r1", input()],
      ["r2", input()],
      ["r3", input()],
    ]);
    review = reduce(review, { type: "findings-merged", at: 30, into: "F2", merged: ["F3"] });
    review = reduce(review, { type: "findings-merged", at: 31, into: "F1", merged: ["F2"] });
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.alsoReported.map((report) => [report.reviewerId, report.findingId])).toEqual([["r2", "F2"], ["r3", "F3"]]);
    expect(review.findingsIssued).toBe(3);
  });

  test("a finding reported after a merge gets a fresh id", () => {
    let review = reviewed([["r1", input()], ["r2", input()]], false);
    for (const reviewerId of ["r1", "r2", "r3"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" });
    review = reduce(review, { type: "findings-merged", at: 30, into: "F1", merged: ["F2"] });
    expect(review.findings.map(({ id }) => id)).toEqual(["F1"]);
    expect(review.findingsIssued).toBe(2);
  });

  test("refused while a reviewer is still reviewing, after the first round started, or for a bad merge", () => {
    const running = reviewed([["r1", input()], ["r2", input()]], false);
    expect(() => reduce(running, { type: "findings-merged", at: 30, into: "F1", merged: ["F2"] })).toThrow(ReviewError);
    const done = reviewed([["r1", input()], ["r2", input()]]);
    expect(() => reduce(done, { type: "findings-merged", at: 30, into: "F1", merged: ["F1"] })).toThrow(ReviewError);
    expect(() => reduce(done, { type: "findings-merged", at: 30, into: "F1", merged: [] })).toThrow(ReviewError);
    expect(() => reduce(done, { type: "findings-merged", at: 30, into: "F1", merged: ["F9"] })).toThrow("no finding F9");
    const deliberating = reduce(reduce(done, { type: "deliberation-started", at: 31, rounds: 1 }), { type: "round-started", at: 32, round: 1 });
    expect(() => reduce(deliberating, { type: "findings-merged", at: 33, into: "F1", merged: ["F2"] })).toThrow(ReviewError);
  });

  test("on deliberation-started, every co-reporter supports at round 0 alongside the reporter", () => {
    let review = reviewed([["r1", input()], ["r2", input()], ["r3", input({ title: "Other" })]]);
    review = reduce(review, { type: "findings-merged", at: 30, into: "F1", merged: ["F2"] });
    review = reduce(review, { type: "deliberation-started", at: 31, rounds: 1 });
    const [first, other] = review.findings;
    expect(first!.positions.map((position) => [position.reviewerId, position.stance, position.round])).toEqual([["r1", "supports", 0], ["r2", "supports", 0]]);
    expect(other!.positions.map((position) => position.reviewerId)).toEqual(["r3"]);
  });
});

describe("the engine merges duplicate reports", () => {
  test("with mock reviewers reporting the same titles, no two findings share a title and a file", async () => {
    const clock = new FakeClock();
    const base = newReview("rev4", { ...setup, seats: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: true })) }, "mock", 0);
    const final = await (async () => {
      const done = new ReviewSession(base, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} }).run();
      await clock.runAll();
      return done;
    })();
    expect(final.phase).toBe("complete");
    const keys = final.findings.flatMap((each) => [...new Set(each.evidence.map((evidence) => `${titleKey(each.title)}@${evidence.path}`))]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(final.findings.some((each) => each.alsoReported.length > 0)).toBe(true);
    expect(final.findingsIssued).toBeGreaterThan(final.findings.length);
  });

  test("a runner reporting one title from two reviewers ends with one finding that both back", async () => {
    const clock = new FakeClock();
    const runner: ReviewerRunner = {
      async run(job, report) {
        report({ type: "finding-reported", finding: input({ severity: job.reviewer.id === "r2" ? "high" : "low" }) });
      },
      async deliberate() {},
      async propose() {},
      async verify() {},
    };
    const base = newReview("rev2", { ...setup, seats: setup.seats.slice(0, 2) }, "mock", 0);
    const done = new ReviewSession(base, { runner, clock, onChange: () => {} }).run();
    await clock.runAll();
    const final = await done;
    expect(final.findings).toHaveLength(1);
    expect(final.findings[0]).toMatchObject({ id: "F2", severity: "high" });
    expect(final.findings[0]!.alsoReported.map((report) => report.reviewerId)).toEqual(["r1"]);
    expect(final.findings[0]!.positions.map((position) => position.reviewerId).sort()).toEqual(["r1", "r2"]);
  });
});

describe("sameProblem with short titles", () => {
  test("one word in common is not enough, even at the same place", () => {
    const at = { path: "src/a.ts", line: 3 };
    const base = { summary: "s", severity: "high" as const, confidence: "high" as const, category: "correctness", evidence: [at], reviewerId: "r1", status: "reported" as const, reportedAt: 0, positions: [], resolution: null, proposal: null, ruling: null, fix: null, alsoReported: [] };
    expect(sameProblem({ ...base, id: "F1", title: "From r1" }, { ...base, id: "F2", title: "From r2, second try" })).toBe(false);
    expect(sameProblem({ ...base, id: "F1", title: "Cache entries never expire" }, { ...base, id: "F2", title: "Stale cache entries never invalidated" })).toBe(true);
  });
});
