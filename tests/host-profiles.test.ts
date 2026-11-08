import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../core/model.ts";
import { createCouncilHost, PROFILES_KEY } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const target = await mkdtemp(join(tmpdir(), "spectra-target-"));
await writeFile(join(target, "README.md"), "# A project\n");

const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** What a profile's agent answers a turn with, told apart by the reply shape its prompt asks for. */
function answer(profile: string, prompt: string): string {
  if (prompt.includes('"proposals"')) {
    const ids = [...prompt.matchAll(/\bF\d+\b/g)].map((match) => match[0]);
    return json({ proposals: [...new Set(ids)].map((findingId) => ({ findingId, summary: "Fix it.", steps: ["Change it."], files: ["README.md"], verification: "Read it." })) });
  }
  if (prompt.includes('"checks"')) return json({ checks: [] });
  if (prompt.includes('"arguments"')) return json({ arguments: [] });
  return json({
    findings: [{ title: `${profile} finding`, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "README.md", line: 1 }] }],
  });
}

function setup() {
  const clock = new FakeClock();
  let ids = 0;
  const options = { clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {} };
  const canvas = new FakeCanvas<Review>();
  return { clock, options, host: createCouncilHost(options), canvas, context: canvas.context() };
}

/** Plays the review, answering every conversation the host starts as soon as it starts; the clock moves only when none waits. */
async function drive({ clock, canvas, context }: ReturnType<typeof setup>, host: ReturnType<typeof createCouncilHost>, reply = answer) {
  let answered = 0;
  for (let i = 0; i < 1_000; i++) {
    await clock.settle();
    if (canvas.started.length > answered) {
      while (answered < canvas.started.length) {
        const started = canvas.started[answered++]!;
        await host.replied!({ id: `conversation-fixer-${answered}`, profile: started.profile }, { text: reply(started.profile, started.prompt), ended: "finished" }, context);
      }
      continue;
    }
    if (!(await clock.step())) return;
  }
  throw new Error("The review never settled.");
}

describe("profile seats", () => {
  test("council_open without agents and no known profile seats nobody; profiles seated before are offered first", async () => {
    const { host, canvas, context } = setup();
    expect(await host.tools.council_open!.run({ target }, context)).toContain("with no reviewer seated yet");
    expect(canvas.items[0]!.data.reviewers).toEqual([]);
    expect(canvas.items[0]!.data.runner).toBe("mock");
    canvas.storage.set(PROFILES_KEY, ["gamma"]);
    await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[1]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:gamma"]);
  });

  test("council_open seats mocks only when named", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["mock-claude"]);
  });

  test("council_open seats profiles and mocks, and the runner kind follows the seats", async () => {
    const { host, canvas, context } = setup();
    const answer = await host.tools.council_open!.run({ target, agents: ["profile:alpha", "mock-codex"] }, context);
    expect(answer).toContain("seating alpha (alpha profile), Codex (mock)");
    expect(canvas.items[0]!.data.runner).toBe("mixed");
    const seats = canvas.items[0]!.data.reviewers.map(({ agent, enabled }) => ({ agent, enabled: agent === "profile:alpha" ? enabled : false }));
    await host.action!(canvas.items[0]!, { kind: "configure", patch: { seats } }, context);
    expect(canvas.items[0]!.data.runner).toBe("mirador");
  });

  test("a council of two profiles reviews, deliberates and proposes through conversations, and remembers the profiles", async () => {
    const harness = setup();
    const { host, canvas, context } = harness;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host);
    const review = canvas.items[0]!.data;
    expect(review.phase).toBe("complete");
    expect(review.findings.map((finding) => finding.title).sort()).toEqual(["alpha finding", "beta finding"]);
    expect(review.findings.every((finding) => finding.proposal !== null)).toBe(true);
    expect(canvas.started.filter((each) => each.profile === "alpha").length).toBeGreaterThanOrEqual(3);
    expect(canvas.storage.get(PROFILES_KEY)).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(await host.action!(canvas.items[0]!, { kind: "profiles" }, context)).toEqual({ profiles: expect.arrayContaining([{ name: "alpha", harness: "", model: null }, { name: "beta", harness: "", model: null }]) });
  });

  test("a seat whose profile ends without the JSON fails, and the other seat carries on", async () => {
    const harness = setup();
    const { host, canvas, context } = harness;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host, (profile, prompt) => (profile === "beta" ? "I looked, it is fine." : answer(profile, prompt)));
    const review = canvas.items[0]!.data;
    expect(review.phase).toBe("complete");
    expect(review.reviewers.find((reviewer) => reviewer.agent === "profile:beta")!.status).toBe("failed");
    expect(review.findings.map((finding) => finding.title)).toEqual(["alpha finding"]);
  });

  test("after a restart, Start asks the agent to call council_begin, which starts the review", async () => {
    const harness = setup();
    const { canvas, context, options } = harness;
    await harness.host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const restarted = createCouncilHost(options);
    await restarted.action!(canvas.items[0]!, { kind: "start" }, context);
    expect(canvas.items[0]!.data.phase).toBe("setup");
    expect(canvas.prompts.at(-1)).toContain("Call council_begin (review rev1)");
    expect(await restarted.tools.council_begin!.run({}, context)).toContain("Started review rev1");
    await drive(harness, restarted);
    expect(canvas.items[0]!.data.phase).toBe("complete");
  });

  test("after a restart, re-checking fixes asks the agent to call council_begin, which runs the verification", async () => {
    const harness = setup();
    const { canvas, context, options, host } = harness;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host);
    const finding = canvas.items[0]!.data.findings[0]!;
    await host.action!(canvas.items[0]!, { kind: "rule", findingId: finding.id, decision: "accepted" }, context);
    await host.action!(canvas.items[0]!, { kind: "fix" }, context);
    await host.tools.council_mark_fixed!.run({ finding: finding.id, summary: "done", files: [] }, context);
    const startedBefore = canvas.started.length;
    const promptsBefore = canvas.prompts.length;

    const restarted = createCouncilHost(options);
    expect(await restarted.action!(canvas.items[0]!, { kind: "verify" }, context)).toEqual({ prompted: true });
    expect(canvas.prompts).toHaveLength(promptsBefore + 1);
    expect(canvas.prompts.at(-1)).toContain("Call council_begin (review rev1)");
    expect(canvas.started).toHaveLength(startedBefore);

    expect(await restarted.tools.council_begin!.run({}, context)).toContain("re-check");
    await drive(harness, restarted);
    expect(canvas.started.length).toBeGreaterThan(startedBefore);
  });

  test("council_begin on a complete review with nothing fixed is refused", async () => {
    const harness = setup();
    const { canvas, context, host } = harness;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host);
    await expect(Promise.resolve().then(() => host.tools.council_begin!.run({}, context))).rejects.toThrow("complete");
  });

  test("a mock council starts without asking the agent", async () => {
    const { host, canvas, context, options } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const restarted = createCouncilHost(options);
    await restarted.action!(canvas.items[0]!, { kind: "start" }, context);
    expect(canvas.prompts).toEqual([]);
    expect(canvas.items[0]!.data.phase).toBe("independent-review");
    restarted.action!(canvas.items[0]!, { kind: "stop" }, context);
  });
});

describe("models from Mirador's records", () => {
  const opus = { name: "Opus 5.5", effort: "high" };
  const qwen = { name: "Qwen 3.8 Max", effort: "medium" };
  /** Records where alpha's latest conversation ran Opus, and every reviewer conversation runs Qwen on beta, Opus on alpha. */
  const records = {
    profiles: () => [
      { name: "alpha", harness: "claude", model: opus },
      { name: "beta", harness: "pi", model: null },
    ],
    modelOf: (id: string) => (id.endsWith("-1") || id.endsWith("-3") ? opus : qwen),
    replyOf: () => null,
  };
  const withRecords = () => {
    const clock = new FakeClock();
    let ids = 0;
    const options = { clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {}, records, modelLookupMs: [] };
    const canvas = new FakeCanvas<Review>();
    return { clock, options, host: createCouncilHost(options), canvas, context: canvas.context() };
  };

  test("the setup names a profile seat by the model its profile last ran on, and lists the profiles", async () => {
    const { host, canvas, context } = withRecords();
    const answer = await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    expect(answer).toContain("seating Opus 5.5 (alpha profile), beta (beta profile)");
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => [reviewer.label, reviewer.model])).toEqual([["Opus 5.5", opus], ["beta", null]]);
    await host.action!(canvas.items[0]!, { kind: "configure", patch: { seats: [{ agent: "profile:beta", enabled: true }, { agent: "profile:alpha", enabled: true }] } }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.label)).toEqual(["beta", "Opus 5.5"]);
    expect(await host.action!(canvas.items[0]!, { kind: "profiles" }, context)).toEqual({ profiles: records.profiles() });
  });

  test("council_open without agents seats the user's first two profiles, never mocks", async () => {
    const { host, canvas, context } = withRecords();
    const answer = await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:alpha", "profile:beta"]);
    expect(canvas.items[0]!.data.runner).toBe("mirador");
    expect(answer).toContain("seating Opus 5.5 (alpha profile), beta (beta profile)");
  });

  test("a running seat is named by the model its conversation runs on", async () => {
    const harness = withRecords();
    const { host, canvas, context } = harness;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host);
    const review = canvas.items[0]!.data;
    expect(review.phase).toBe("complete");
    expect(review.reviewers.every((reviewer) => reviewer.model !== null)).toBe(true);
    expect(new Set(review.reviewers.map((reviewer) => reviewer.label)).size).toBe(2);
  });

  test("Run again asks the agent to open a new review with the same setup, once the review ended", async () => {
    const { host, canvas, context } = withRecords();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "mock-codex"], instructions: "Mind the cache." }, context);
    await expect(host.action!(canvas.items[0]!, { kind: "rerun" }, context)).rejects.toThrow("once it has ended");
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await host.action!(canvas.items[0]!, { kind: "stop" }, context);
    expect(canvas.items[0]!.data.phase).toBe("stopped");
    await host.action!(canvas.items[0]!, { kind: "rerun" }, context);
    expect(canvas.prompts.at(-1)).toContain("Call council_open with");
    expect(canvas.prompts.at(-1)).toContain('"agents":["profile:alpha","mock-codex"]');
    expect(canvas.prompts.at(-1)).toContain('"instructions":"Mind the cache."');
  });
});
