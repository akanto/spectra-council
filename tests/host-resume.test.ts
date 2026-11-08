import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../core/model.ts";
import { createCouncilHost, IN_FLIGHT_KEY } from "../hosts/mirador/host.ts";
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

/** A host with its own clock, over a canvas that can be shared by a restarted host. */
function boot(canvas = new FakeCanvas<Review>(), nextId = 1) {
  const clock = new FakeClock();
  let ids = nextId - 1;
  const options = { clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {} };
  return { clock, options, host: createCouncilHost(options), canvas, context: canvas.context() };
}
type Env = ReturnType<typeof boot>;

/** Conversations already answered, by index in `canvas.started`. */
const answered = new WeakMap<FakeCanvas<Review>, Set<number>>();

/**
 * Plays the review: answers each conversation the canvas started (unless `hold` says to leave it) as soon as it starts;
 * the clock moves only when none waits. Returns when the clock is idle.
 */
async function drive({ clock, canvas, context }: Env, host: Env["host"], reply = answer, hold: (index: number, started: { profile: string; prompt: string }) => boolean = () => false) {
  const done = answered.get(canvas) ?? answered.set(canvas, new Set()).get(canvas)!;
  for (let i = 0; i < 1_000; i++) {
    await clock.settle();
    const next = canvas.started.findIndex((started, index) => !done.has(index) && !hold(index, started));
    if (next >= 0) {
      done.add(next);
      const started = canvas.started[next]!;
      await host.replied!({ id: `conversation-fixer-${next + 1}`, profile: started.profile }, { text: reply(started.profile, started.prompt), ended: "finished" }, context);
      continue;
    }
    // A held conversation is still waiting for its turn: moving the clock on would run out its turn limit.
    if (canvas.started.some((started, index) => !done.has(index) && hold(index, started))) return;
    if (!(await clock.step())) return;
  }
  throw new Error("The review never settled.");
}

describe("resuming after a restart", () => {
  test("a mock review resumes on a new host and runs to completion", async () => {
    const first = boot();
    await first.host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, first.context);
    const id = first.canvas.items[0]!.id;
    await first.host.action!(first.canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, first.context);
    await first.host.action!(first.canvas.item(id), { kind: "start" }, first.context);
    for (let i = 0; i < 3; i++) await first.clock.step();
    expect(first.canvas.item(id).data.phase).toBe("independent-review");

    // A restart: the item says it runs, but no session exists in the new host.
    const second = boot(first.canvas);
    expect(second.host.items.council!.outcome!(second.canvas.item(id).data)).toStartWith("running");
    await second.host.action!(second.canvas.item(id), { kind: "resume" }, second.context);
    expect(second.canvas.prompts).toEqual([]);
    expect(second.canvas.item(id).data.phase).toBe("independent-review");
    await second.clock.runAll();
    await second.clock.settle();
    const review = second.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.verdict?.summary).toBeTruthy();
    expect(review.interruptedPhase).toBeNull();
  });

  test("a review that isn't interrupted can't be resumed", async () => {
    const { host, canvas, context, clock } = boot();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    // In setup, resume is the same as start, which is fine; a finished review is not.
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await host.action!(canvas.items[0]!, { kind: "stop" }, context);
    await clock.settle();
    expect(canvas.items[0]!.data.phase).toBe("stopped");
    await expect(host.action!(canvas.items[0]!, { kind: "resume" }, context)).rejects.toThrow("ask the agent to open a new one");
  });

  test("a profile review takes over the earlier conversations, uses a reply kept meanwhile and completes", async () => {
    const first = boot();
    await first.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, first.context);
    const id = first.canvas.items[0]!.id;
    await first.host.action!(first.canvas.item(id), { kind: "start" }, first.context);
    await first.clock.settle();
    // Both conversations are under way and unanswered.
    expect(first.canvas.started.map((each) => each.profile)).toEqual(["alpha", "beta"]);
    expect(Object.keys(first.canvas.storage.get(IN_FLIGHT_KEY) as object)).toEqual(["conversation-fixer-1", "conversation-fixer-2"]);

    const second = boot(first.canvas);
    // Alpha's conversation ended while no review waited for it: its reply is kept in the plugin storage.
    const alpha = first.canvas.started[0]!;
    await second.host.replied!({ id: "conversation-fixer-1", profile: "alpha" }, { text: answer("alpha", alpha.prompt), ended: "finished" }, second.context);
    expect((first.canvas.storage.get(IN_FLIGHT_KEY) as Record<string, { reply?: unknown }>)["conversation-fixer-1"]!.reply).toBeDefined();

    // With no tool context in the new host, Resume asks the agent to call council_begin.
    await second.host.action!(second.canvas.item(id), { kind: "resume" }, second.context);
    expect(second.canvas.prompts.at(-1)).toContain(`Call council_begin (review ${first.canvas.item(id).data.id})`);
    expect(second.canvas.prompts.at(-1)).toContain("resumed");
    expect(second.canvas.item(id).data.reviewers[0]!.status).toBe("reviewing");
    expect(first.canvas.started).toHaveLength(2);

    expect(await second.host.tools.council_begin!.run({}, second.context)).toContain("Resumed review");
    await second.clock.settle();
    // The same prompts, so the earlier conversations were taken over rather than started again.
    expect(first.canvas.started).toHaveLength(2);
    const resumed = second.canvas.item(id).data;
    expect(resumed.reviewers[0]).toMatchObject({ status: "completed" });
    expect(resumed.findings.map((finding) => finding.title)).toEqual(["alpha finding"]);
    expect(resumed.reviewers[1]!.status).toBe("reviewing");

    // Beta's earlier conversation is the one still waiting: answer it, then the rest of the review.
    await drive(second, second.host);
    const review = second.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.findings.map((finding) => finding.title).sort()).toEqual(["alpha finding", "beta finding"]);
    // The first beta conversation did the beta review; later conversations are deliberation and proposals.
    expect(first.canvas.started.filter((each) => each.prompt === beta(first).prompt)).toHaveLength(1);
    expect(first.canvas.storage.get(IN_FLIGHT_KEY)).toBeUndefined();
  });
});

const beta = (env: Env) => env.canvas.started[1]!;

describe("retrying a reviewer", () => {
  test("a profile seat that failed (no JSON, twice) runs again", async () => {
    const env = boot();
    const { host, canvas, context, clock } = env;
    await host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    // Alpha stays at work; beta answers without the JSON, then again after being asked once more.
    const holdAlpha = (_: number, started: { profile: string }) => started.profile === "alpha";
    await drive(env, host, (profile, prompt) => (profile === "beta" ? "I looked, it is fine." : answer(profile, prompt)), holdAlpha);
    expect(canvas.started.filter((each) => each.profile === "beta")).toHaveLength(2);
    expect(canvas.item(id).data.phase).toBe("independent-review");
    expect(canvas.item(id).data.reviewers[1]).toMatchObject({ status: "failed" });
    expect(canvas.item(id).data.reviewers[1]!.problem).toContain("twice");

    await host.action!(canvas.item(id), { kind: "retry", reviewerId: "r2" }, context);
    await clock.settle();
    expect(canvas.item(id).data.reviewers[1]!.status).toBe("reviewing");
    expect(canvas.started.filter((each) => each.profile === "beta")).toHaveLength(3);

    await drive(env, host);
    const review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.reviewers[1]).toMatchObject({ status: "completed", problem: null });
    expect(review.findings.map((finding) => finding.title).sort()).toEqual(["alpha finding", "beta finding"]);
  });

  test("a review that isn't running refuses a retry", async () => {
    const { host, canvas, context, clock } = boot();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await expect(host.action!(canvas.item(id), { kind: "retry", reviewerId: "r1" }, context)).rejects.toThrow("isn't running");
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.runAll();
    await clock.settle();
    expect(canvas.item(id).data.phase).toBe("complete");
    await expect(host.action!(canvas.item(id), { kind: "retry", reviewerId: "r1" }, context)).rejects.toThrow("isn't running");
  });

  test("a running review refuses a retry of a reviewer that didn't fail", async () => {
    const { host, canvas, context, clock } = boot();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.step();
    await expect(host.action!(canvas.item(id), { kind: "retry", reviewerId: "r1" }, context)).rejects.toThrow("hasn't failed");
    host.action!(canvas.item(id), { kind: "stop" }, context);
  });
});

describe("ruling on a handed-off finding", () => {
  test("dismissing an unfixed handed-off finding clears its fix and tells the agent", async () => {
    const { host, canvas, context, clock } = boot();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, context);
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.runAll();
    await clock.settle();
    const act = (action: unknown) => host.action!(canvas.item(id), action, context);
    const review = () => canvas.item(id).data;
    const ids = review().findings.filter((finding) => ["agreed", "confirmed", "disputed"].includes(finding.status)).map((finding) => finding.id);
    expect(ids.length).toBeGreaterThan(1);
    for (const findingId of ids) await act({ kind: "rule", findingId, decision: "accepted" });
    await act({ kind: "fix" });
    expect(review().findings.filter((finding) => finding.fix?.state === "handed-off").map((finding) => finding.id)).toEqual(ids);
    const prompts = canvas.prompts.length;

    await act({ kind: "rule", findingId: ids[0]!, decision: "dismissed", note: "not a problem" });
    const dismissed = review().findings.find((finding) => finding.id === ids[0])!;
    expect(dismissed.fix).toBeNull();
    expect(dismissed.ruling).toMatchObject({ decision: "dismissed", note: "not a problem" });
    expect(review().findings.find((finding) => finding.id === ids[1])!.fix?.state).toBe("handed-off");
    expect(canvas.prompts).toHaveLength(prompts + 1);
    expect(canvas.prompts.at(-1)).toContain(`took ${ids[0]} out of the fixes`);
    expect(canvas.prompts.at(-1)).toContain("dismissed");
    expect(canvas.promptOptions.at(-1)).toEqual({ afterTurn: true });

    // Changing only a note on a still-accepted finding doesn't tell the agent anything.
    await act({ kind: "rule", findingId: ids[1]!, decision: "accepted", note: "yes, really" });
    expect(canvas.prompts).toHaveLength(prompts + 1);
    expect(review().findings.find((finding) => finding.id === ids[1])!.fix?.state).toBe("handed-off");
  });
});

describe("conversations taken over after a restart: only the right ones", () => {
  test("a conversation that a crash cut short (reported failed) is not taken over: its work starts anew", async () => {
    const first = boot();
    await first.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"] }, first.context);
    const id = first.canvas.items[0]!.id;
    await first.host.action!(first.canvas.item(id), { kind: "start" }, first.context);
    await first.clock.settle();
    const second = boot(first.canvas);
    await second.host.replied!({ id: "conversation-fixer-1", profile: "alpha" }, { text: null, ended: "failed" }, second.context);
    await second.host.action!(second.canvas.item(id), { kind: "resume" }, second.context);
    await second.host.tools.council_begin!.run({}, second.context);
    await second.clock.settle();
    // Alpha's review started again in a third conversation; beta's earlier one was taken over.
    expect(first.canvas.started.map((each) => each.profile)).toEqual(["alpha", "beta", "alpha"]);
    expect(second.canvas.item(id).data.reviewers[0]!.status).toBe("reviewing");
  });

  test("a conversation given up on in this process (stopped) leaves nothing to take over", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    await env.clock.settle();
    expect(Object.keys(env.canvas.storage.get(IN_FLIGHT_KEY) as object)).toHaveLength(1);
    await env.host.action!(env.canvas.item(id), { kind: "stop" }, env.context);
    await env.clock.settle();
    expect(env.canvas.storage.get(IN_FLIGHT_KEY)).toBeUndefined();
  });
});
