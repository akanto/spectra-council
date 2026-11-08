import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../core/agent-runner.ts";
import { groupingPrompt } from "../core/agent-turns.ts";
import { ReviewSession, type AgentReply, type Conversations, type Report, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce, ReviewError, upgradeReview, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { FakeClock } from "./support.ts";

const seatsOf = (agents: string[]) => agents.map((agent) => ({ agent, enabled: true }));
const setup = (agents = ["profile:Home", "profile:Pi", "profile:Qa"]) => ({ target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: seatsOf(agents) });
const fresh = (agents?: string[]) => newReview("rev1", setup(agents), "mock", 0);

const input = (title: string, path: string, patch: Partial<FindingInput> = {}): FindingInput => ({
  title,
  summary: "Something is wrong.",
  severity: "medium",
  confidence: "high",
  category: "correctness",
  evidence: [{ path, line: 3 }],
  ...patch,
});

const play = (review: Review, events: ReviewEvent[]) => events.reduce(reduce, review);
const IDS = ["r1", "r2", "r3"];

/** Every seat reviewed; r1 reported F1, r2 F2 and r3 F3, all with unrelated titles. Deliberation started, round 0. */
function deliberating(patch: [string, FindingInput][] = []): Review {
  const reports: [string, FindingInput][] = patch.length > 0 ? patch : [["r1", input("Cache never expires", "src/a.ts")], ["r2", input("Stale entries survive restart", "src/b.ts", { severity: "high" })], ["r3", input("Logs leak tokens", "src/c.ts")]];
  return play(fresh(), [
    { type: "started", at: 1 },
    ...IDS.map((reviewerId): ReviewEvent => ({ type: "reviewer-started", reviewerId, at: 2 })),
    ...reports.map(([reviewerId, finding], index): ReviewEvent => ({ type: "finding-reported", reviewerId, at: 3 + index, finding })),
    ...IDS.map((reviewerId): ReviewEvent => ({ type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" })),
    { type: "deliberation-started", at: 21, rounds: 2 },
  ]);
}

describe("findings-merged in the deliberation", () => {
  test("is allowed at round 0, and the co-reporters back the finding from round 0", () => {
    const review = reduce(deliberating(), { type: "findings-merged", at: 30, into: "F2", merged: ["F1"], by: "r3", reason: "Same root cause." });
    expect(review.findings.map(({ id }) => id)).toEqual(["F2", "F3"]);
    const kept = review.findings[0]!;
    expect(kept.positions.map((position) => [position.reviewerId, position.stance, position.round]).sort()).toEqual([["r1", "supports", 0], ["r2", "supports", 0]]);
    expect(review.findings[1]!.positions.map((position) => position.reviewerId)).toEqual(["r3"]);
  });

  test("each new co-report carries who merged it and why", () => {
    const review = reduce(deliberating(), { type: "findings-merged", at: 30, into: "F1", merged: ["F2", "F3"], by: "r3", reason: "Same root cause." });
    expect(review.findings[0]!.alsoReported.map((report) => [report.findingId, report.mergedBy, report.reason])).toEqual([
      ["F2", "r3", "Same root cause."],
      ["F3", "r3", "Same root cause."],
    ]);
  });

  test("without by and reason, the co-report has neither", () => {
    const review = reduce(deliberating(), { type: "findings-merged", at: 30, into: "F1", merged: ["F2"] });
    const [report] = review.findings[0]!.alsoReported;
    expect(report).not.toHaveProperty("mergedBy");
    expect(report).not.toHaveProperty("reason");
  });

  test("the grouping reviewer gets a finding activity", () => {
    const review = reduce(deliberating(), { type: "findings-merged", at: 30, into: "F1", merged: ["F2"], by: "r3", reason: "Same root cause." });
    expect(review.reviewers[2]!.activity.at(-1)).toMatchObject({ kind: "finding", text: "Merged F2 into F1: Same root cause.", at: 30 });
    expect(review.reviewers[0]!.activity.at(-1)!.text).not.toStartWith("Merged");
  });

  test("a merger that is not a reviewer in the council leaves no activity", () => {
    const before = deliberating();
    const review = reduce(before, { type: "findings-merged", at: 30, into: "F1", merged: ["F2"], by: "nobody" });
    expect(review.reviewers.map((reviewer) => reviewer.activity.length)).toEqual(before.reviewers.map((reviewer) => reviewer.activity.length));
  });

  test("is refused once the first round started", () => {
    const round = reduce(deliberating(), { type: "round-started", at: 31, round: 1 });
    expect(() => reduce(round, { type: "findings-merged", at: 32, into: "F1", merged: ["F2"], by: "r3", reason: "x" })).toThrow(ReviewError);
  });
});

describe("duplicates-checked", () => {
  test("a new review is unchecked; the event sets it at round 0 of the deliberation", () => {
    const review = deliberating();
    expect(review.duplicatesChecked).toBe(false);
    expect(reduce(review, { type: "duplicates-checked", at: 30 }).duplicatesChecked).toBe(true);
  });

  test("is refused outside the deliberation's round 0", () => {
    expect(() => reduce(fresh(), { type: "duplicates-checked", at: 1 })).toThrow(ReviewError);
    const independent = reduce(fresh(), { type: "started", at: 1 });
    expect(() => reduce(independent, { type: "duplicates-checked", at: 2 })).toThrow(ReviewError);
    const round = reduce(deliberating(), { type: "round-started", at: 31, round: 1 });
    expect(() => reduce(round, { type: "duplicates-checked", at: 32 })).toThrow(ReviewError);
  });
});

describe("upgradeReview to format 7", () => {
  const stored = (patch: Partial<Review>): Review => {
    const old = { ...fresh(), ...patch, format: 6 } as unknown as Partial<Review>;
    delete old.duplicatesChecked;
    return old as Review;
  };

  test("a review not past the independent review is unchecked", () => {
    for (const patch of [{ phase: "setup" }, { phase: "independent-review" }, { phase: "interrupted", interruptedPhase: "independent-review" }] as Partial<Review>[]) {
      const upgraded = upgradeReview(stored(patch));
      expect(upgraded.format).toBe(8);
      expect(upgraded.duplicatesChecked).toBe(false);
    }
  });

  test("a review further along counts as checked", () => {
    for (const patch of [{ phase: "deliberation" }, { phase: "complete" }, { phase: "interrupted", interruptedPhase: "deliberation" }, { phase: "stopped" }] as Partial<Review>[]) {
      expect(upgradeReview(stored(patch)).duplicatesChecked).toBe(true);
    }
  });
});

describe("resume around the grouping turn", () => {
  const interrupt = (review: Review) => reduce(review, { type: "interrupted", at: 40 });

  test("a review interrupted during the grouping turn is still unchecked after resuming", () => {
    const resumed = reduce(interrupt(deliberating()), { type: "resumed", at: 50 });
    expect(resumed).toMatchObject({ phase: "deliberation", round: 0, duplicatesChecked: false });
  });

  test("one interrupted in round 1 after the grouping stays checked", () => {
    const checked = play(deliberating(), [{ type: "duplicates-checked", at: 30 }, { type: "round-started", at: 31, round: 1 }]);
    const resumed = reduce(interrupt(checked), { type: "resumed", at: 50 });
    expect(resumed).toMatchObject({ phase: "deliberation", round: 0, duplicatesChecked: true });
  });

  /** A runner that only counts the grouping turns; the rest does nothing. */
  function counting() {
    const grouped: string[] = [];
    const runner: ReviewerRunner = {
      async run() {},
      async deliberate() {},
      async propose() {},
      async verify() {},
      async group(job) {
        grouped.push(job.reviewer.id);
      },
    };
    return { grouped, runner };
  }

  test("the engine asks again on resume when the grouping was cut short, and not when it was done", async () => {
    for (const [review, expected] of [
      [interrupt(deliberating()), ["r1"]],
      [interrupt(play(deliberating(), [{ type: "duplicates-checked", at: 30 }, { type: "round-started", at: 31, round: 1 }])), []],
    ] as [Review, string[]][]) {
      const clock = new FakeClock();
      const { grouped, runner } = counting();
      const done = new ReviewSession(review, { runner, clock, onChange: () => {} }).resume();
      await clock.runAll();
      expect((await done).phase).toBe("complete");
      expect(grouped).toEqual(expected);
    }
  });
});

/** Two profile seats, each reporting findings with unrelated titles and files, so the rule merge catches nothing. */
function councilRunner(group: ReviewerRunner["group"], log: string[] = []) {
  const runner: ReviewerRunner = {
    async run(job, report) {
      log.push(`run ${job.reviewer.id}`);
      const mine: [string, string][] = job.reviewer.id === "r1" ? [["Cache never expires", "src/a.ts"], ["Logs leak tokens", "src/c.ts"]] : [["Stale entries survive restart", "src/b.ts"]];
      for (const [title, path] of mine) report({ type: "finding-reported", finding: input(title, path) });
    },
    async deliberate(job) {
      log.push(`deliberate ${job.reviewer.id}`);
    },
    async propose() {},
    async verify() {},
    ...(group ? { group: async (job, report, signal) => { log.push(`group ${job.reviewer.id}`); await group(job, report, signal); } } : {}),
  };
  return runner;
}

async function runCouncil(runner: ReviewerRunner, agents = ["profile:Home", "profile:Pi"]) {
  const clock = new FakeClock();
  const session = new ReviewSession(fresh(agents), { runner, clock, onChange: () => {} });
  const done = session.run();
  await clock.runAll();
  return done;
}

const grouped = (findingIds: string[], reason = "One root cause."): Report => ({ type: "duplicates-grouped", group: { findingIds, reason } });

describe("the engine's grouping turn", () => {
  test("the first profile reviewer groups once, before any deliberation, and the group merges", async () => {
    const log: string[] = [];
    const runner = councilRunner(async (_job, report) => report(grouped(["F1", "F3"])), log);
    const final = await runCouncil(runner);
    expect(final.phase).toBe("complete");
    expect(log.filter((entry) => entry.startsWith("group"))).toEqual(["group r1"]);
    expect(log.indexOf("group r1")).toBeLessThan(log.findIndex((entry) => entry.startsWith("deliberate")));
    expect(final.duplicatesChecked).toBe(true);
    expect(final.findings.map(({ id }) => id)).toEqual(["F1", "F2"]);
    const [kept] = final.findings;
    expect(kept!.alsoReported).toMatchObject([{ findingId: "F3", reviewerId: "r2", mergedBy: "r1", reason: "One root cause." }]);
    expect(kept!.positions.map((position) => position.reviewerId).sort()).toEqual(["r1", "r2"]);
    expect(final.reviewers[0]!.activity.some((entry) => entry.text === "Merged F3 into F1: One root cause.")).toBe(true);
  });

  test("the keeper is the most severe finding, the earliest among equals", async () => {
    const runner = councilRunner(async (job, report) => {
      expect(job.review.findings).toHaveLength(4);
      report(grouped(["F3", "F1"]));
      report(grouped(["F2", "F4"]));
    });
    const patched: ReviewerRunner = {
      ...runner,
      async run(job, report, signal) {
        await runner.run(job, report, signal);
        if (job.reviewer.id === "r2") report({ type: "finding-reported", finding: input("Another", "src/z.ts", { severity: "critical" }) });
      },
    };
    const final = await runCouncil(patched);
    // F3 and F1 are equally medium: F1 stays. F4 is critical, so F2 merges into it.
    expect(final.findings.map(({ id }) => id)).toEqual(["F1", "F4"]);
    expect(final.findings[1]!.severity).toBe("critical");
    expect(final.findings[0]!.alsoReported.map((report) => report.findingId)).toEqual(["F3"]);
  });

  test("a group naming an unknown finding is rejected and nothing merges", async () => {
    const final = await runCouncil(councilRunner(async (_job, report) => report(grouped(["F1", "F9"]))));
    expect(final.findings).toHaveLength(3);
    expect(final.reviewers[0]!.activity.some((entry) => entry.kind === "error" && entry.text === "Rejected a malformed group: there is no finding F9")).toBe(true);
    expect(final.duplicatesChecked).toBe(true);
  });

  test("a malformed group is rejected", async () => {
    const runner = councilRunner(async (_job, report) => {
      report({ type: "duplicates-grouped", group: { findingIds: ["F1"], reason: "alone" } });
      report({ type: "duplicates-grouped", group: { findingIds: ["F1", "F2"] } });
    });
    const final = await runCouncil(runner);
    expect(final.findings).toHaveLength(3);
    expect(final.reviewers[0]!.activity.filter((entry) => entry.kind === "error" && entry.text.startsWith("Rejected a malformed group: "))).toHaveLength(2);
  });

  test("ids already merged away resolve to the finding they went into", async () => {
    const final = await runCouncil(
      councilRunner(async (_job, report) => {
        report(grouped(["F1", "F2"]));
        // F2 is part of F1 now: this group is F1 and F3.
        report(grouped(["F2", "F3"], "Also the same."));
        // Everything is one finding already: nothing to do.
        report(grouped(["F1", "F3"]));
      }),
    );
    expect(final.findings.map(({ id }) => id)).toEqual(["F1"]);
    expect(final.findings[0]!.alsoReported.map((report) => report.findingId)).toEqual(["F2", "F3"]);
    expect(final.findings[0]!.alsoReported.map((report) => report.reason)).toEqual(["One root cause.", "Also the same."]);
    expect(final.reviewers[0]!.activity.filter((entry) => entry.kind === "error")).toEqual([]);
  });

  test("a group that resolves to one finding does nothing", async () => {
    const final = await runCouncil(
      councilRunner(async (_job, report) => {
        report(grouped(["F1", "F2"]));
        report(grouped(["F1", "F2"]));
      }),
    );
    expect(final.findings).toHaveLength(2);
    expect(final.findings[0]!.alsoReported).toHaveLength(1);
  });

  test("a council of mocks never gets a grouping turn", async () => {
    const log: string[] = [];
    const final = await runCouncil(councilRunner(async () => {}, log), ["mock-claude", "mock-codex"]);
    expect(final.phase).toBe("complete");
    expect(log.some((entry) => entry.startsWith("group"))).toBe(false);
    expect(final.duplicatesChecked).toBe(false);
  });

  test("a runner without group, or a review with one finding, skips the turn", async () => {
    const final = await runCouncil(councilRunner(undefined));
    expect(final.phase).toBe("complete");
    expect(final.duplicatesChecked).toBe(false);

    const log: string[] = [];
    const single: ReviewerRunner = {
      ...councilRunner(async () => {}, log),
      async run(job, report) {
        if (job.reviewer.id === "r1") report({ type: "finding-reported", finding: input("Only one", "src/a.ts") });
      },
    };
    expect((await runCouncil(single)).phase).toBe("complete");
    expect(log.some((entry) => entry.startsWith("group"))).toBe(false);
  });

  test("a grouping turn that throws shows as an error, and the review goes on", async () => {
    const log: string[] = [];
    const final = await runCouncil(
      councilRunner(async () => {
        throw new Error("boom");
      }, log),
    );
    expect(final.phase).toBe("complete");
    expect(final.duplicatesChecked).toBe(true);
    expect(final.findings).toHaveLength(3);
    expect(final.reviewers[0]!.activity.some((entry) => entry.kind === "error" && entry.text === "Failed grouping duplicate findings: boom")).toBe(true);
    // The grouper stays in the deliberation.
    expect(log).toContain("deliberate r1");
    expect(final.reviewers[0]!.status).toBe("completed");
  });

  test("a mock seat before a profile seat doesn't group; the first profile seat does", async () => {
    const log: string[] = [];
    await runCouncil(councilRunner(async () => {}, log), ["mock-claude", "profile:Pi"]);
    expect(log.filter((entry) => entry.startsWith("group"))).toEqual(["group r2"]);
  });
});

/** Conversations whose replies a test scripts per prompt; records every prompt. */
class FakeConversations implements Conversations {
  prompts: { profile: string; prompt: string }[] = [];
  constructor(private handler: (profile: string, prompt: string) => string) {}
  async ask({ profile, prompt }: Parameters<Conversations["ask"]>[0]): Promise<AgentReply> {
    this.prompts.push({ profile, prompt });
    return { conversationId: `c-${this.prompts.length}`, profile, ended: "finished", text: this.handler(profile, prompt) };
  }
}

const json = (value: unknown, prose = "") => `${prose}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const evidence = [{ path: "src/a.ts", line: 3, quote: "x" }];
const reported = (title: string) => ({ title, summary: `${title} is wrong.`, severity: "high", confidence: "high", category: "correctness", evidence });

describe("AgentRunner.group", () => {
  test("asks the first profile seat, reads the json block and merges the group", async () => {
    const conversations = new FakeConversations((profile, prompt) => {
      if (prompt.includes('{ "groups": [ ... ] }')) return json({ groups: [{ findingIds: ["F1", "F2"], reason: "Both lack the cache expiry." }] }, "Compared them.");
      if (prompt.includes("deliberation round")) return json({ arguments: [] });
      if (prompt.includes("draft one fix proposal")) return json({ proposals: [] });
      return json({ findings: [reported(profile === "alpha" ? "Cache never expires" : "Entries survive forever")] });
    });
    const clock = new FakeClock();
    const session = new ReviewSession(newReview("rev", { ...setup(), seats: seatsOf(["profile:alpha", "profile:beta"]) }, "mirador", 0), { runner: new AgentRunner(conversations, clock), clock, onChange: () => {} });
    const done = session.run();
    await clock.runAll();
    const final = await done;

    const groupings = conversations.prompts.filter((each) => each.prompt.includes('{ "groups": [ ... ] }'));
    expect(groupings.map((each) => each.profile)).toEqual(["alpha"]);
    expect(groupings[0]!.prompt).toContain("F1");
    expect(groupings[0]!.prompt).toContain("F2");
    expect(final.phase).toBe("complete");
    expect(final.duplicatesChecked).toBe(true);
    expect(final.findings).toHaveLength(1);
    expect(final.findings[0]!.alsoReported).toMatchObject([{ findingId: "F2", reviewerId: "r2", mergedBy: "r1", reason: "Both lack the cache expiry." }]);
    expect(final.reviewers[0]!.activity.some((entry) => entry.text === "Reported 1 group")).toBe(true);
  });

  test("an empty list of groups reports nothing and still counts as checked", async () => {
    const conversations = new FakeConversations((profile, prompt) => {
      if (prompt.includes('{ "groups": [ ... ] }')) return json({ groups: [] });
      if (prompt.includes("deliberation round")) return json({ arguments: [] });
      if (prompt.includes("draft one fix proposal")) return json({ proposals: [] });
      return json({ findings: [reported(`${profile} finding`)] });
    });
    const clock = new FakeClock();
    const session = new ReviewSession(newReview("rev", { ...setup(), seats: seatsOf(["profile:alpha", "profile:beta"]) }, "mirador", 0), { runner: new AgentRunner(conversations, clock), clock, onChange: () => {} });
    const done = session.run();
    await clock.runAll();
    const final = await done;
    expect(final.findings).toHaveLength(2);
    expect(final.duplicatesChecked).toBe(true);
  });
});

describe("groupingPrompt", () => {
  test("lists every finding id and asks for the groups reply", () => {
    const review = reduce(deliberating(), { type: "duplicates-checked", at: 30 });
    const prompt = groupingPrompt({ review, reviewer: review.reviewers[0]!, profile: PROFILES.code });
    for (const { id, title } of review.findings) {
      expect(prompt).toContain(id);
      expect(prompt).toContain(title);
    }
    expect(prompt).toContain('{ "groups": [ ... ] }');
    expect(prompt).toContain("findingIds");
  });
});
