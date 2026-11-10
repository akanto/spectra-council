import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasActionContext, CanvasToolContext, StartedConversation } from "../hosts/mirador/api.ts";
import type { Review } from "../core/model.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const target = await mkdtemp(join(tmpdir(), "spectra-stop-"));
await writeFile(join(target, "README.md"), "# A project\n");

const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** What a profile's agent answers a turn with, told apart by the reply shape its prompt asks for. */
function answer(profile: string, prompt: string): string {
  if (prompt.includes('"proposals"')) {
    const ids = [...new Set([...prompt.matchAll(/\bF\d+\b/g)].map((match) => match[0]))];
    return json({ proposals: ids.map((findingId) => ({ findingId, summary: "Fix it.", steps: ["Change it."], files: ["README.md"], verification: "Read it." })) });
  }
  if (prompt.includes('"groups"')) return json({ groups: [] });
  if (prompt.includes('"checks"')) return json({ checks: [] });
  if (prompt.includes('"arguments"')) return json({ arguments: [] });
  return json({
    findings: [{ title: `${profile} finding`, summary: "Something is wrong.", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "README.md", line: 1 }] }],
  });
}

type Context = CanvasToolContext<Review> & CanvasActionContext<Review>;

function boot(canvas = new FakeCanvas<Review>()) {
  const clock = new FakeClock();
  let ids = 0;
  const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {}, modelLookupMs: [] });
  return { clock, host, canvas, context: canvas.context() };
}
type Env = ReturnType<typeof boot>;

/**
 * Answers each conversation whose profile `hold` doesn't name, and stops once only held ones are left, so their turns
 * are still running; the clock moves only while nothing is held.
 */
async function drive({ clock, canvas, context, host }: Env, hold: (profile: string) => boolean = () => false) {
  const answered = new Set<number>();
  for (let i = 0; i < 1_000; i++) {
    await clock.settle();
    const next = canvas.started.findIndex((started, index) => !answered.has(index) && !hold(started.profile));
    if (next >= 0) {
      answered.add(next);
      const started = canvas.started[next]!;
      await host.replied!({ id: `conversation-fixer-${next + 1}`, profile: started.profile }, { text: answer(started.profile, started.prompt), ended: "finished" }, context);
      continue;
    }
    if (canvas.started.some((started, index) => !answered.has(index) && hold(started.profile))) return;
    if (!(await clock.step())) return;
  }
  throw new Error("The review never settled.");
}

/** A three-seat review on `context` played until only beta's and gamma's review conversations still run. */
async function midReview(contextOf: (env: Env) => Context = (env) => env.context) {
  const env = boot();
  const context = contextOf(env);
  await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta", "profile:gamma"], depth: "quick" }, context);
  const id = env.canvas.items[0]!.id;
  await env.host.action!(env.canvas.item(id), { kind: "start" }, context);
  await drive({ ...env, context }, (profile) => profile !== "alpha");
  return { ...env, context, id };
}

describe("stopping a review stops its reviewers' conversations", () => {
  test("the view's Stop stops each conversation still running, and not the one that already replied", async () => {
    const env = await midReview();
    await env.host.action!(env.canvas.item(env.id), { kind: "stop" }, env.context);
    await env.clock.settle();
    expect(env.canvas.stopped).toEqual(["conversation-fixer-2", "conversation-fixer-3"]);
    expect(env.canvas.item(env.id).data.phase).toBe("stopped");
  });

  test("council_stop stops them the same way", async () => {
    const env = await midReview();
    expect(await env.host.tools.council_stop!.run({}, env.context)).toBe("Stopped review rev1.");
    await env.clock.settle();
    expect(env.canvas.stopped).toEqual(["conversation-fixer-2", "conversation-fixer-3"]);
    expect(env.canvas.item(env.id).data.phase).toBe("stopped");
  });

  test("a turn that hits its turn limit does not stop its conversation", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    await drive(env, (profile) => profile === "beta");
    expect(env.canvas.stopped).toEqual([]);

    await env.clock.runAll();
    await env.clock.settle();
    expect(env.canvas.item(id).data.reviewers[1]).toMatchObject({ status: "failed", problem: "Its turn took longer than 15 minutes" });
    expect(env.canvas.stopped).toEqual([]);
  });

  test("on a Mirador without stopConversation a stop still ends the review as before", async () => {
    const env = await midReview((older) => {
      const context: Context = { ...older.context };
      delete context.stopConversation;
      return context;
    });
    await env.host.action!(env.canvas.item(env.id), { kind: "stop" }, env.context);
    await env.clock.settle();
    expect(env.canvas.item(env.id).data.phase).toBe("stopped");
    expect(env.canvas.stopped).toEqual([]);
  });

  test("a conversation a restart left running is stopped once a resume takes it over", async () => {
    const first = boot();
    await first.host.tools.council_open!.run({ target, agents: ["profile:alpha"], depth: "quick" }, first.context);
    const id = first.canvas.items[0]!.id;
    await first.host.action!(first.canvas.item(id), { kind: "start" }, first.context);
    await first.clock.settle();
    expect(first.canvas.started).toHaveLength(1);

    const second = boot(first.canvas);
    await second.host.tools.council_begin!.run({}, second.context);
    await second.clock.settle();
    expect(first.canvas.started).toHaveLength(1);

    await second.host.action!(second.canvas.item(id), { kind: "stop" }, second.context);
    await second.clock.settle();
    expect(first.canvas.stopped).toEqual(["conversation-fixer-1"]);
  });
});

describe("the stopped reply that comes after a stop", () => {
  test("changes nothing and tells no one", async () => {
    const env = await midReview();
    await env.host.action!(env.canvas.item(env.id), { kind: "stop" }, env.context);
    await env.clock.settle();
    const before = JSON.stringify(env.canvas.item(env.id).data);
    const prompts = env.canvas.prompts.length;

    for (const index of [1, 2]) {
      const started = env.canvas.started[index]!;
      await env.host.replied!({ id: `conversation-fixer-${index + 1}`, profile: started.profile }, { text: null, ended: "stopped" }, env.context);
    }

    expect(env.canvas.prompts).toHaveLength(prompts);
    expect(JSON.stringify(env.canvas.item(env.id).data)).toBe(before);
  });
});

describe("a conversation whose start resolves after the stop", () => {
  test("is stopped as well", async () => {
    const env = boot();
    const starts: ((started: StartedConversation) => void)[] = [];
    const context: Context = {
      ...env.context,
      startConversation: (start) =>
        new Promise((resolve) => {
          env.canvas.started.push(start);
          starts.push(resolve);
        }),
    };
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha"], depth: "quick" }, context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, context);
    await env.clock.settle();
    expect(starts).toHaveLength(1);

    await env.host.action!(env.canvas.item(id), { kind: "stop" }, context);
    await env.clock.settle();
    expect(env.canvas.stopped).toEqual([]);

    starts[0]!({ id: "conversation-late", profile: "alpha" });
    await env.clock.settle();
    expect(env.canvas.stopped).toEqual(["conversation-late"]);
    expect(env.canvas.item(id).data.phase).toBe("stopped");
  });
});
