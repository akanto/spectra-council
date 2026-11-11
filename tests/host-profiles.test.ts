import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNNAMED_PROFILE } from "../core/agents.ts";
import type { Review } from "../core/model.ts";
import { createCouncilHost, LAST_SEATS_KEY, PROFILES_KEY } from "../hosts/mirador/host.ts";
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
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:gamma"]);
  });

  test("council_open seats mocks only when named", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["mock-claude"]);
  });

  test("council_open seats profiles and mocks, and the runner kind follows the seats", async () => {
    const { host, canvas, context } = setup();
    const answer = await host.tools.council_open!.run({ target, agents: ["profile:alpha", "mock-codex"] }, context);
    expect(answer).toContain("seating R1 · alpha (alpha profile), R2 · Codex (mock)");
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
    expect(answer).toContain("seating R1 · Opus 5.5 · high (alpha profile), R2 · beta (beta profile)");
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => [reviewer.label, reviewer.model])).toEqual([["R1 · Opus 5.5 · high", opus], ["R2 · beta", null]]);
    await host.action!(canvas.items[0]!, { kind: "configure", patch: { seats: [{ agent: "profile:beta", enabled: true }, { agent: "profile:alpha", enabled: true }] } }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.label)).toEqual(["R1 · beta", "R2 · Opus 5.5 · high"]);
    expect(await host.action!(canvas.items[0]!, { kind: "profiles" }, context)).toEqual({ profiles: records.profiles() });
  });

  test("council_open without agents seats the user's first two profiles, never mocks", async () => {
    const { host, canvas, context } = withRecords();
    const answer = await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:alpha", "profile:beta"]);
    expect(canvas.items[0]!.data.runner).toBe("mirador");
    expect(answer).toContain("seating R1 · Opus 5.5 · high (alpha profile), R2 · beta (beta profile)");
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

describe("the user starts a review", () => {
  test("council_begin refuses a review in setup that the user hasn't pressed Start on", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    await expect(Promise.resolve().then(() => host.tools.council_begin!.run({}, context))).rejects.toThrow("The user hasn't pressed Start on review rev1");
    expect(canvas.items[0]!.data.phase).toBe("setup");
    expect(canvas.started).toEqual([]);
  });

  test("council_begin starts the review while Start's prompt to call it is still waiting for the turn to end", async () => {
    const harness = setup();
    const { canvas, context, options } = harness;
    await harness.host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const restarted = createCouncilHost(options);
    let turnEnded!: () => void;
    const waitingForTheTurn = {
      ...context,
      prompt: (text: string) => {
        canvas.prompts.push(text);
        return new Promise<void>((resolve) => (turnEnded = resolve));
      },
    };
    const starting = restarted.action!(canvas.items[0]!, { kind: "start" }, waitingForTheTurn);
    await harness.clock.settle();
    expect(canvas.prompts.at(-1)).toContain("Call council_begin (review rev1)");
    expect(await restarted.tools.council_begin!.run({}, context)).toContain("Started review rev1");
    expect(canvas.storage.get(LAST_SEATS_KEY)).toEqual([{ agent: "profile:alpha", enabled: true }]);
    turnEnded();
    expect(await starting).toEqual({ prompted: true });
    await drive(harness, restarted);
    expect(canvas.items[0]!.data.phase).toBe("complete");
  });

  test("council_begin refuses, with the reason, a review whose seat became an unnamed profile after Start asked for it", async () => {
    const { canvas, context, options, host } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const restarted = createCouncilHost(options);
    expect(await restarted.action!(canvas.items[0]!, { kind: "start" }, context)).toEqual({ prompted: true });
    await restarted.action!(canvas.items[0]!, { kind: "configure", patch: { seats: [{ agent: UNNAMED_PROFILE, enabled: true }] } }, context);
    await expect(Promise.resolve().then(() => restarted.tools.council_begin!.run({}, context))).rejects.toThrow("Name the Mirador profile for reviewer 1 before starting the review.");
    expect(canvas.items[0]!.data.phase).toBe("setup");
    expect(canvas.started).toEqual([]);
  });

  test("a Start whose ask to the agent fails leaves the review for the user to start again, and replaceable", async () => {
    const { canvas, context, options, host } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const restarted = createCouncilHost(options);
    const unreachable = { ...context, prompt: async () => Promise.reject(new Error("The conversation is gone.")) };
    await expect(restarted.action!(canvas.items[0]!, { kind: "start" }, unreachable)).rejects.toThrow("The conversation is gone.");
    await expect(Promise.resolve().then(() => restarted.tools.council_begin!.run({}, context))).rejects.toThrow("The user hasn't pressed Start on review rev1");
    await restarted.tools.council_open!.run({ target, agents: ["profile:beta"] }, context);
    expect(canvas.items.map((item) => item.data.id)).toEqual(["rev2"]);
  });

  test("a Start or a change of setup sent for a review the agent replaced meanwhile is refused", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    const shown = canvas.items[0]!.data.id;
    await host.tools.council_open!.run({ target, agents: ["mock-codex"] }, context);
    const item = canvas.items[0]!;
    await expect(Promise.resolve().then(() => host.action!(item, { kind: "start", review: shown }, context))).rejects.toThrow(`Review ${shown} was replaced by review rev2`);
    await expect(Promise.resolve().then(() => host.action!(item, { kind: "configure", review: shown, patch: { instructions: "Mind the cache." } }, context))).rejects.toThrow(`Review ${shown} was replaced by review rev2`);
    expect(canvas.items[0]!.data.phase).toBe("setup");
    await host.action!(item, { kind: "configure", review: "rev2", patch: { instructions: "Mind the cache." } }, context);
    expect(canvas.items[0]!.data.instructions).toBe("Mind the cache.");
  });

  test("a Start on a review the agent has since replaced is refused, and the review in its place stays in setup", async () => {
    const { canvas, context, host } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    const pressedOn = { ...canvas.items[0]! };
    await host.tools.council_open!.run({ target, agents: ["mock-codex"] }, context);
    await expect(Promise.resolve().then(() => host.action!(pressedOn, { kind: "start" }, context))).rejects.toThrow("Review rev1 was replaced by review rev2");
    expect(canvas.items[0]!.data).toMatchObject({ id: "rev2", phase: "setup" });
  });
});

describe("opening a review while another is unstarted", () => {
  const document = join(target, "README.md");

  test("the new review takes the unstarted one's place in its tab, with the reviewers the user picked there", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "configure", patch: { seats: [{ agent: "profile:gamma", enabled: true, model: "qwen" }] } }, context);
    const answer = await host.tools.council_open!.run({ target: document, profile: "scientific", title: "The findings" }, context);
    expect(canvas.items).toHaveLength(1);
    const review = canvas.items[0]!.data;
    expect([review.id, review.target, review.profile, canvas.items[0]!.title]).toEqual(["rev2", document, "scientific", "The findings"]);
    expect(review.reviewers.map(({ agent, choice }) => [agent, choice])).toEqual([["profile:gamma", { model: "qwen" }]]);
    expect(answer).toContain("in place of review rev1, which the user hadn't started and is gone now: same tab (item item-1)");
    expect(answer).toContain("(kept from review rev1)");
    await expect(Promise.resolve().then(() => host.tools.council_begin!.run({ review: "rev1" }, context))).rejects.toThrow("No review rev1 in this conversation; its reviews are rev2");
  });

  test("reviewers the agent names replace the unstarted review's", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const answer = await host.tools.council_open!.run({ target: document, agents: ["profile:beta"] }, context);
    expect(canvas.items).toHaveLength(1);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:beta"]);
    expect(answer).not.toContain("kept from");
  });

  test("a mock demo's seats aren't kept for the real review opened in its place", async () => {
    const { host, canvas, context } = setup();
    canvas.storage.set(PROFILES_KEY, ["alpha", "beta"]);
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    await host.tools.council_open!.run({ target }, context);
    expect(canvas.items).toHaveLength(1);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:alpha", "profile:beta"]);
    expect(canvas.items[0]!.data.runner).toBe("mirador");
  });

  test("a started, dismissed or asked-to-start review stays, and the new one opens beside it", async () => {
    const harness = setup();
    const { host, canvas, context, options } = harness;
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await host.tools.council_open!.run({ target, agents: ["mock-codex"] }, context);
    expect(canvas.items).toHaveLength(2);

    canvas.items[1]!.dismissed = true;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    expect(canvas.items).toHaveLength(3);

    const restarted = createCouncilHost(options);
    expect(await restarted.action!(canvas.items[2]!, { kind: "start" }, context)).toEqual({ prompted: true });
    await restarted.tools.council_open!.run({ target, agents: ["profile:beta"] }, context);
    expect(canvas.items).toHaveLength(4);
    expect(canvas.items.map((item) => item.data.id)).toEqual(["rev1", "rev2", "rev3", "rev4"]);
    host.action!(canvas.items[0]!, { kind: "stop" }, context);
  });
});

describe("the reviewers seated by default", () => {
  test("are the profile seats the user last started a review with, with their model and effort", async () => {
    const harness = setup();
    const { host, canvas, context } = harness;
    canvas.storage.set(PROFILES_KEY, ["alpha", "beta"]);
    await host.tools.council_open!.run({ target, agents: [{ agent: "profile:gamma", model: "qwen", effort: "high" }, "profile:delta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await drive(harness, host);
    await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[1]!.data.reviewers.map(({ agent, choice }) => [agent, choice])).toEqual([
      ["profile:gamma", { model: "qwen", effort: "high" }],
      ["profile:delta", undefined],
    ]);
  });

  test("a mock demo doesn't change them", async () => {
    const { host, canvas, context } = setup();
    canvas.storage.set(LAST_SEATS_KEY, [{ agent: "profile:gamma", enabled: true }]);
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "profile:delta"] }, context);
    await host.action!(canvas.items[0]!, { kind: "configure", patch: { seats: [{ agent: "mock-claude", enabled: true }] } }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    expect(canvas.storage.get(LAST_SEATS_KEY)).toEqual([{ agent: "profile:gamma", enabled: true }]);
    host.action!(canvas.items[0]!, { kind: "stop" }, context);
  });

  test("leave out profiles Mirador no longer has, and fall back to its first two when none is left", async () => {
    const records = {
      profiles: () => [
        { name: "alpha", harness: "claude", model: null },
        { name: "beta", harness: "pi", model: null },
        { name: "gamma", harness: "pi", model: null },
      ],
      modelOf: () => null,
      replyOf: () => null,
    };
    const canvas = new FakeCanvas<Review>();
    const context = canvas.context();
    const host = createCouncilHost({ clock: new FakeClock(), listFiles: async () => FILES, throttleMs: 0, records, modelLookupMs: [] });
    canvas.storage.set(LAST_SEATS_KEY, [{ agent: "profile:gone", enabled: true }, { agent: "profile:Gamma", enabled: true }]);
    await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[0]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:Gamma"]);
    canvas.items[0]!.dismissed = true;
    canvas.storage.set(LAST_SEATS_KEY, [{ agent: "profile:gone", enabled: true }]);
    await host.tools.council_open!.run({ target }, context);
    expect(canvas.items[1]!.data.reviewers.map((reviewer) => reviewer.agent)).toEqual(["profile:alpha", "profile:beta"]);
  });
});
