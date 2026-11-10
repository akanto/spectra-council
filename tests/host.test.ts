import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomeOf } from "../core/describe.ts";
import type { Review } from "../core/model.ts";
import { createCouncilHost, PROFILES_KEY } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const target = await mkdtemp(join(tmpdir(), "spectra-target-"));
await writeFile(join(target, "README.md"), "# A project\n");

const asyncRun = async <T>(fn: () => T) => fn();

function setup() {
  const clock = new FakeClock();
  let ids = 0;
  const written: { path: string; text: string }[] = [];
  const host = createCouncilHost({
    clock,
    listFiles: async () => FILES,
    newId: () => `rev${++ids}`,
    throttleMs: 0,
    writeFile: async (path, text) => void written.push({ path, text }),
  });
  const canvas = new FakeCanvas<Review>();
  return { clock, host, canvas, context: canvas.context(), written };
}

describe("the Mirador host", () => {
  test("start after a restart reports that the agent was prompted", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, context);
    const restarted = createCouncilHost();
    expect(await restarted.action!(canvas.items[0]!, { kind: "start" }, context)).toEqual({ prompted: true });
    expect(canvas.items[0]!.data.phase).toBe("setup");
    expect(canvas.prompts).toHaveLength(1);
    expect(canvas.promptOptions[0]).toEqual({ afterTurn: true });
  });

  test("a runner from runnerFor plays the agents it takes, and the others keep theirs", async () => {
    const clock = new FakeClock();
    const played: string[] = [];
    const host = createCouncilHost({
      clock,
      listFiles: async () => FILES,
      throttleMs: 0,
      writeFile: async () => {},
      runnerFor: (agent) =>
        agent === "profile:scripted"
          ? {
              run: async (job, report) => {
                played.push(job.reviewer.agent);
                report({ type: "finding-reported", finding: { title: "Scripted finding", summary: "It happens.", severity: "low", confidence: "high", category: "correctness", evidence: [{ path: "README.md", line: 1 }] } });
              },
              deliberate: async () => {},
              propose: async () => {},
              verify: async () => {},
            }
          : undefined,
    });
    const canvas = new FakeCanvas<Review>();
    const context = canvas.context();
    await host.tools.council_open!.run({ target, agents: ["profile:scripted", "mock-claude"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.runAll();
    await clock.settle();
    const review = canvas.item(id).data;
    expect(played).toEqual(["profile:scripted"]);
    expect(review.findings.some((finding) => finding.title === "Scripted finding" && finding.reviewerId === "r1")).toBe(true);
    // The mock seat ran as a mock, and no conversation was started for the scripted profile seat.
    expect(review.findings.some((finding) => finding.reviewerId === "r2")).toBe(true);
    // The conversation hears only that its review finished: nothing was asked of it, and no conversation started for the seat.
    expect(canvas.prompts).toEqual([expect.stringContaining("is finished")]);
    expect(canvas.started).toHaveLength(0);
  });

  test("source paths resolve against real file and folder targets without changing the review", async () => {
    const { host, canvas, context } = setup();
    const folder = join(target, "folder.with.dots");
    await mkdir(folder, { recursive: true });
    for (const name of ["report.md", "file with spaces", "LICENSE"]) await writeFile(join(folder, name), "test");
    await host.tools.council_open!.run({ target, agents: ["mock-codex"] }, context);
    const initial = canvas.items[0]!;
    const resolve = (reviewTarget: string, path: string) => host.action!({ ...initial, data: { ...initial.data, target: reviewTarget } }, { kind: "resolve-path", path }, context);
    for (const name of ["report.md", "file with spaces", "LICENSE"]) {
      expect(await resolve(join(folder, name), name)).toEqual({ path: join(folder, name) });
      expect(await resolve(join(folder, name), "nested/source.ts")).toEqual({ path: join(folder, "nested/source.ts") });
    }
    for (const dir of [folder, folder + "/"]) expect(await resolve(dir, "nested/source.ts")).toEqual({ path: join(folder, "nested/source.ts") });
    const missing = join(target, "missing");
    await expect(resolve(missing, "/absolute/source.ts")).rejects.toThrow("unavailable");
    await expect(resolve(missing, "source.ts")).rejects.toThrow("unavailable");
    expect(await resolve(folder, join(folder, "report.md"))).toEqual({ path: join(folder, "report.md") });
    expect(await resolve(join(folder, "report.md"), join(folder, "other.ts"))).toEqual({ path: join(folder, "other.ts") });
    const outside = await mkdtemp(join(tmpdir(), "spectra-outside-"));
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(outside, join(folder, "link"));
    await symlink(join(outside, "not-yet.txt"), join(folder, "dangling"));
    for (const reviewTarget of [folder, join(folder, "report.md")]) {
      for (const path of ["/absolute/outside.ts", join(outside, "secret.txt"), "../outside.ts", "nested/../../outside.ts", "link/secret.txt", "link", "dangling"]) {
        await expect(resolve(reviewTarget, path)).rejects.toThrow("outside the review target");
      }
    }
    expect(canvas.items[0]).toEqual(initial);
  });

  test("one reviewer can accept reported findings, hand them off and request fixes", async () => {
    const { host, canvas, context, clock, written } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    const id = canvas.items[0]!.id;
    const act = (action: unknown) => host.action!(canvas.item(id), action, context);
    await act({ kind: "start" });
    await clock.runAll();
    await clock.settle();
    const review = () => canvas.item(id).data;
    expect(review().phase).toBe("complete");
    expect(review().rounds).toBe(0);
    expect(review().findings.length).toBeGreaterThan(0);
    const first = review().findings[0]!;
    expect(first.status).toBe("reported");
    for (const decision of ["dismissed", "deferred", null, "accepted"]) await act({ kind: "rule", findingId: first.id, decision });
    await act({ kind: "handoff" });
    expect(written[0]!.text).toContain(first.recommendation!);
    await act({ kind: "fix" });
    expect(review().findings[0]!.fix?.state).toBe("handed-off");
    expect(review().findings[0]!.status).toBe("reported");
    expect(review().findings[0]!.resolution).toBeNull();
    expect(review().findings.slice(1).every((finding) => !finding.fix)).toBe(true);
  });

  test("council_open publishes a review in setup", async () => {
    const { host, canvas, context } = setup();
    const answer = await host.tools.council_open!.run({ target, profile: "security", agents: ["mock-gemini"] }, context);
    expect(answer).toContain("Opened Spectra Council review rev1");
    const [item] = canvas.items;
    expect(item!.type).toBe("council");
    expect(item!.title).toStartWith("Security review · spectra-target-");
    expect(item!.data.phase).toBe("setup");
    expect(item!.data.reviewers.map((reviewer) => [reviewer.label, reviewer.enabled])).toEqual([["Gemini", true]]);
  });

  test("council_open refuses a relative or missing target", async () => {
    const { host, context } = setup();
    await expect(host.tools.council_open!.run({ target: "repo" }, context)).rejects.toThrow("absolute path");
    await expect(host.tools.council_open!.run({ target: join(target, "nope") }, context)).rejects.toThrow("There is no file or folder");
  });

  test("the tool inputs are JSON Schemas of objects", () => {
    const { host } = setup();
    for (const tool of Object.values(host.tools)) expect(tool.input).toMatchObject({ type: "object" });
  });

  test("the view configures and starts a review, which runs to completion and tells its agent of the verdict, not again by note", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, context);
    expect(canvas.item(id).data.depth).toBe("quick");
    expect(host.note!(context)).toBeNull();

    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.step();
    expect(canvas.item(id).data.phase).toBe("independent-review");
    expect(host.items.council!.outcome!(canvas.item(id).data)).toStartWith("running");
    await clock.runAll();
    await clock.settle();

    const review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.findings.length).toBeGreaterThan(0);
    expect(review.rounds).toBeGreaterThan(0);
    expect(review.round).toBe(review.rounds);
    expect(review.arguments.length).toBeGreaterThan(0);
    expect(review.verdict?.summary).toBeTruthy();
    expect(review.findings.every((finding) => finding.status !== "reported" && finding.resolution !== null)).toBe(true);
    expect(review.reviewers.filter((reviewer) => reviewer.enabled).every((reviewer) => reviewer.status === "completed")).toBe(true);
    expect(await host.tools.council_status!.run({}, context)).toContain(`${review.findings.length}`);

    // The finished prompt marked the review heard as it went out: the agent has nothing left to hear by note.
    expect(host.note!(context)).toBeNull();
  });

  describe("the message that a review is finished", () => {
    /** A review of this canvas's item, run to its verdict. */
    async function toTheVerdict(env: ReturnType<typeof setup>) {
      const { host, canvas, context, clock } = env;
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      const id = canvas.items[0]!.id;
      await host.action!(canvas.item(id), { kind: "start" }, context);
      await clock.runAll();
      await clock.settle();
      return canvas.item(id).data;
    }

    test("comes once to the review's own conversation, counted, and asks for no council tool", async () => {
      const env = setup();
      const { canvas } = env;
      const review = await toTheVerdict(env);
      expect(review.phase).toBe("complete");
      expect(canvas.prompts).toHaveLength(1);
      expect(canvas.promptOptions).toEqual([{ afterTurn: true }]);
      expect(canvas.prompts[0]).toContain(`Spectra Council review ${review.id} is finished (${outcomeOf(review)})`);
      expect(canvas.prompts[0]).toContain("Tell the user in one or two lines");
      expect(canvas.prompts[0]).toContain("without calling any council tool");
    });

    test("says nothing about a review the user stopped on the way", async () => {
      const { host, canvas, context, clock } = setup();
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      const id = canvas.items[0]!.id;
      await host.action!(canvas.item(id), { kind: "start" }, context);
      for (let i = 0; i < 3; i++) await clock.step();
      await host.action!(canvas.item(id), { kind: "stop" }, context);
      await clock.runAll();
      await clock.settle();
      expect(canvas.item(id).data.phase).toBe("stopped");
      expect(canvas.prompts).toEqual([]);
      // An ending no prompt carried still reaches the agent by note, once.
      const note = host.note!(context)!;
      expect(note.text).toContain("Spectra Council review rev1 ended (stopped)");
      note.heard();
      expect(host.note!(context)).toBeNull();
    });

    test("says nothing when a host only reads the finished review, as after a restart or a rebuilt canvas", async () => {
      const env = setup();
      const { canvas, context, clock } = env;
      await toTheVerdict(env);
      canvas.prompts = [];
      const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0 });
      expect(restarted.items.council!.listed!(canvas.items[0]!).phase).toBe("complete");
      await restarted.tools.council_status!.run({}, context);
      expect(canvas.prompts).toEqual([]);
    });

    test("goes in the plugin's own voice, through the tool call's context, though the user started the run from the view", async () => {
      const { host, canvas, context, clock } = setup();
      const typedByTheUser: string[] = [];
      const view = { ...context, prompt: async (text: string) => void typedByTheUser.push(text) };
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      await host.action!(canvas.items[0]!, { kind: "start" }, view);
      await clock.runAll();
      await clock.settle();
      expect(canvas.prompts).toEqual([expect.stringContaining("is finished")]);
      expect(typedByTheUser).toEqual([]);
    });

    test("with no tool call since a restart, leaves the verdict to the note", async () => {
      const { host, canvas, context, clock } = setup();
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0, writeFile: async () => {} });
      await restarted.action!(canvas.items[0]!, { kind: "start" }, context);
      await clock.runAll();
      await clock.settle();
      expect(canvas.items[0]!.data.phase).toBe("complete");
      expect(canvas.prompts).toEqual([]);
      expect(restarted.note!(context)!.text).toContain("Spectra Council review rev1 ended (complete)");
    });

    test("a verdict whose telling couldn't be sent is given back to the note, not lost", async () => {
      const { host, canvas, context, clock } = setup();
      const gone = { ...context, prompt: async () => { throw new Error("The conversation is gone."); } };
      const logged: unknown[][] = [];
      const real = console.error;
      console.error = (...args: unknown[]) => logged.push(args);
      try {
        await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, gone);
        const id = canvas.items[0]!.id;
        await host.action!(canvas.item(id), { kind: "start" }, gone);
        await clock.runAll();
        await clock.settle();
        expect(canvas.item(id).data.phase).toBe("complete");
        expect(canvas.item(id).data.agentHeardAt).toBeNull();
        expect(host.note!(context)!.text).toContain("Spectra Council review rev1 ended (complete)");
        expect(logged.map((args) => String(args[0])).some((text) => text.includes("couldn't be told"))).toBe(true);
      } finally {
        console.error = real;
      }
    });

    test("a telling that fails late takes back only its own heard mark, not a later run's", async () => {
      const { host, canvas, context, clock } = setup();
      let failSend = (_: Error) => {};
      const slow = { ...context, prompt: () => new Promise<void>((_, reject) => (failSend = reject)) };
      const real = console.error;
      console.error = () => {};
      try {
        await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, slow);
        const id = canvas.items[0]!.id;
        await host.action!(canvas.item(id), { kind: "start" }, slow);
        await clock.runAll();
        await clock.settle();
        const told = canvas.item(id);
        const laterMark = told.data.agentHeardAt! + 60_000;
        canvas.items[canvas.items.indexOf(told)] = { ...told, data: { ...told.data, agentHeardAt: laterMark } };
        failSend(new Error("The conversation is gone."));
        await clock.settle();
        expect(canvas.item(id).data.agentHeardAt).toBe(laterMark);
        expect(host.note!(context)).toBeNull();
      } finally {
        console.error = real;
      }
    });

    test("a review a restart cut short is never listed as ended: its note says nothing", async () => {
      const { clock, host, canvas, context } = setup();
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      const id = canvas.items[0]!.id;
      await host.action!(canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, context);
      await host.action!(canvas.item(id), { kind: "start" }, context);
      for (let i = 0; i < 3; i++) await clock.step();
      expect(canvas.item(id).data.phase).toBe("independent-review");
      const restarted = createCouncilHost({ clock: new FakeClock(), listFiles: async () => FILES, throttleMs: 0, writeFile: async () => {} });
      expect(restarted.note!(context)).toBeNull();
    });

    test("a run resumed after a restart still tells its verdict, exactly once", async () => {
      const env = setup();
      const { canvas, context } = env;
      await env.host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      const id = canvas.items[0]!.id;
      await env.host.action!(canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, context);
      await env.host.action!(canvas.item(id), { kind: "start" }, context);
      for (let i = 0; i < 3; i++) await env.clock.step();
      expect(canvas.item(id).data.phase).toBe("independent-review");
      // A restart: the work in flight is left behind on the old clock; a new host over the same canvas takes it over.
      const clock = new FakeClock();
      const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0, writeFile: async () => {} });
      const before = canvas.prompts.length;
      expect(await restarted.tools.council_begin!.run({ review: "rev1" }, context)).toContain("Resumed review rev1");
      await clock.runAll();
      await clock.settle();
      expect(canvas.item(id).data.phase).toBe("complete");
      expect(canvas.prompts.slice(before).filter((text) => text.includes("is finished"))).toHaveLength(1);
      expect(restarted.note!(context)).toBeNull();
    });

    test("doesn't wait for the turn it starts: the fixes can be re-checked while that turn goes on", async () => {
      const { host, canvas, context, clock } = setup();
      const toldInTurnsThatGoOn: string[] = [];
      const turnGoesOn = {
        ...context,
        prompt: (text: string) => {
          toldInTurnsThatGoOn.push(text);
          return new Promise<void>(() => {});
        },
      };
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, turnGoesOn);
      const id = canvas.items[0]!.id;
      const act = (action: unknown) => host.action!(canvas.item(id), action, context);
      await act({ kind: "start" });
      await clock.runAll();
      await clock.settle();
      const ids = standing(canvas.item(id).data).map((finding) => finding.id);
      for (const findingId of ids) await act({ kind: "rule", findingId, decision: "accepted" });
      await act({ kind: "fix" });
      for (const finding of ids) await host.tools.council_mark_fixed!.run({ finding, summary: "done", files: ["src/a.ts"] }, turnGoesOn);
      await act({ kind: "verify" });
      await clock.runAll();
      await clock.settle();
      expect(canvas.item(id).data.verifications).toBe(1);
      expect(toldInTurnsThatGoOn.filter((text) => text.includes("is finished"))).toHaveLength(2);
    });

    test("says nothing when the user stops a re-check of the fixes, which leaves the review complete", async () => {
      const { host, canvas, context, clock, review, act } = await completed();
      for (const finding of standing(review())) await act({ kind: "rule", findingId: finding.id, decision: "accepted" });
      await act({ kind: "fix" });
      for (const finding of standing(review())) await host.tools.council_mark_fixed!.run({ finding: finding.id, summary: "done", files: ["src/a.ts"] }, context);
      await act({ kind: "verify" });
      await clock.step();
      expect(review().phase).toBe("verification");
      await act({ kind: "stop" });
      await clock.runAll();
      await clock.settle();
      expect(review().phase).toBe("complete");
      expect(canvas.prompts.filter((text) => text.includes("is finished"))).toEqual([]);
      // Neither channel tells: the verdict this stopped re-check returns to was already heard, so the note stays silent too.
      expect(host.note!(context)).toBeNull();
    });

    test("comes again when a re-check of the fixes ends, once for that run", async () => {
      const { host, canvas, context, clock, review, act } = await completed();
      for (const finding of standing(review())) await act({ kind: "rule", findingId: finding.id, decision: "accepted" });
      await act({ kind: "fix" });
      for (const finding of standing(review())) await host.tools.council_mark_fixed!.run({ finding: finding.id, summary: "done", files: ["src/a.ts"] }, context);
      await act({ kind: "verify" });
      await clock.step();
      await clock.runAll();
      await clock.settle();
      expect(review().phase).toBe("complete");
      expect(canvas.prompts.filter((text) => text.includes("is finished"))).toHaveLength(1);
    });
  });

  test("stop from the view stops a running review", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    for (let i = 0; i < 3; i++) await clock.step();
    await host.action!(canvas.item(id), { kind: "stop" }, context);
    await clock.runAll();
    await clock.settle();
    expect(canvas.item(id).data.phase).toBe("stopped");
  });

  test("council_stop stops an active running review and marks it stopped", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    for (let i = 0; i < 3; i++) await clock.step();
    expect(await host.tools.council_stop!.run({}, context)).toBe("Stopped review rev1.");
    await clock.runAll();
    await clock.settle();
    expect(canvas.item(id).data.phase).toBe("stopped");
    expect(canvas.item(id).data.reviewers.filter((reviewer) => reviewer.enabled).every((reviewer) => reviewer.status !== "reviewing")).toBe(true);
  });

  test("council_stop on an idle or finished review reports its current phase without error", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    expect(await host.tools.council_stop!.run({}, context)).toBe("Review rev1 isn't running (phase: setup); there is nothing to stop.");
    expect(canvas.item(id).data.phase).toBe("setup");

    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.step();
    const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0 });
    expect(await restarted.tools.council_stop!.run({ review: "rev1" }, context)).toContain("(phase: interrupted)");

    await clock.runAll();
    await clock.settle();
    expect(await host.tools.council_stop!.run({ review: "rev1" }, context)).toContain("(phase: complete)");
    expect(canvas.item(id).data.phase).toBe("complete");
    await expect(asyncRun(() => host.tools.council_stop!.run({ review: "rev9" }, context))).rejects.toThrow("No review rev9");
  });

  test("council_profiles lists formatted profile entries from storage", async () => {
    const records = {
      profiles: () => [
        { name: "alpha", harness: "claude", model: { name: "Opus 5.5", effort: "high" } },
        { name: "pi home", harness: "pi", model: null },
      ],
      modelOf: () => null,
      replyOf: () => null,
    };
    const fromRecords = createCouncilHost({ clock: new FakeClock(), records });
    expect(await fromRecords.tools.council_profiles!.run({}, new FakeCanvas<Review>().context())).toBe("Mirador profiles to seat:\n- profile:alpha (Opus 5.5 · high)\n- profile:pi home");

    const { host, canvas, context } = setup();
    expect(await host.tools.council_profiles!.run({}, context)).toBe("No Mirador profile is known to Spectra Council yet; the user can pick reviewers in the review's setup.");
    canvas.storage.set(PROFILES_KEY, ["beta", "gamma"]);
    expect(await host.tools.council_profiles!.run({}, context)).toBe("Mirador profiles to seat:\n- profile:beta\n- profile:gamma");
  });

  test("a review left running by an earlier Mirador shows as interrupted", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.step();
    const running = canvas.item(id);

    // A new host is Mirador after a restart: no session runs the review any more.
    const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0 });
    expect(restarted.items.council!.listed!(running).phase).toBe("interrupted");
    expect(await restarted.tools.council_status!.run({}, context)).toContain("interrupted");
    await host.action!(canvas.item(id), { kind: "stop" }, context);
  });

  test("bad actions and a second start are refused with a reason", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const id = canvas.items[0]!.id;
    await expect(host.action!(canvas.item(id), { kind: "dance" }, context)).rejects.toThrow("Unknown action");
    await host.action!(canvas.item(id), { kind: "configure", patch: { seats: Array.from({ length: 4 }, () => ({ agent: "mock-qwen", enabled: false })) } }, context);
    await expect(host.action!(canvas.item(id), { kind: "start" }, context)).rejects.toThrow("Seat at least one reviewer");
  });

  test("a review stored in format 1 is read fine and upgraded", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
    const { arguments: _a, round: _r, rounds: _rs, verdict: _v, ...rest } = canvas.items[0]!.data;
    const stored = {
      ...rest,
      format: 1,
      phase: "complete",
      findings: [{ id: "F1", reviewerId: "r1", title: "Old", summary: "s", severity: "low", confidence: "low", category: "c", evidence: [], status: "reported", reportedAt: 1 }],
    } as unknown as Review;
    canvas.items[0] = { ...canvas.items[0]!, data: stored };

    const listed = host.items.council!.listed!(canvas.items[0]!);
    expect(listed).toMatchObject({ format: 8, arguments: [], round: 0, rounds: 0, verdict: null });
    expect(listed).toMatchObject({ handoff: null, verifications: 0 });
    expect(listed.findings[0]).toMatchObject({ positions: [], resolution: null, proposal: null, ruling: null, fix: null });
    expect(await host.tools.council_status!.run({}, context)).toContain("Old");
  });

  /** A finished review with an item id, ready to be ruled on. */
  async function completed() {
    const env = setup();
    // Four reviewers, so enough distinct findings stand once duplicates merge.
    await env.host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"] }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "configure", patch: { depth: "quick" } }, env.context);
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    await env.clock.runAll();
    await env.clock.settle();
    // These tests are about what the review asks of the agent after its verdict, not about the message its verdict brought.
    env.canvas.prompts = [];
    env.canvas.promptOptions = [];
    const review = () => env.canvas.item(id).data;
    const act = (action: unknown) => env.host.action!(env.canvas.item(id), action, env.context);
    return { ...env, id, review, act };
  }

  const standing = (review: Review) => review.findings.filter((finding) => finding.status === "agreed" || finding.status === "confirmed" || finding.status === "disputed");

  describe("after the verdict", () => {
    test("the view rules on findings", async () => {
      const { review, act } = await completed();
      expect(review().phase).toBe("complete");
      const [first, second] = standing(review());
      expect(first).toBeDefined();
      await act({ kind: "rule", findingId: first!.id, decision: "accepted", note: "yes" });
      expect(review().findings.find((it) => it.id === first!.id)!.ruling).toMatchObject({ decision: "accepted", note: "yes" });
      await act({ kind: "rule", findingId: first!.id, decision: null });
      expect(review().findings.find((it) => it.id === first!.id)!.ruling).toBeNull();
      await expect(act({ kind: "rule", findingId: "F999", decision: "accepted" })).rejects.toThrow("no finding F999");
      await expect(act({ kind: "rule", findingId: first!.id, decision: "maybe" })).rejects.toThrow("Unknown action");
      void second;
    });

    test("council_rule updates the finding ruling state to accepted/dismissed/deferred and clears it with null", async () => {
      const { host, canvas, context, review } = await completed();
      const finding = standing(review())[0]!.id;
      const rulingOf = () => review().findings.find((it) => it.id === finding)!.ruling;
      expect(await host.tools.council_rule!.run({ finding, decision: "accepted", note: "the user agrees" }, context)).toBe(`Accepted ${finding} in review rev1.`);
      expect(rulingOf()).toMatchObject({ decision: "accepted", note: "the user agrees" });
      expect(await host.tools.council_rule!.run({ review: "rev1", finding, decision: "dismissed" }, context)).toBe(`Dismissed ${finding} in review rev1.`);
      expect(rulingOf()).toMatchObject({ decision: "dismissed", note: "" });
      expect(await host.tools.council_rule!.run({ finding, decision: "deferred", note: "later" }, context)).toBe(`Deferred ${finding} in review rev1.`);
      expect(rulingOf()).toMatchObject({ decision: "deferred", note: "later" });
      expect(await host.tools.council_rule!.run({ finding, decision: null }, context)).toBe(`Cleared the ruling on ${finding} in review rev1.`);
      expect(rulingOf()).toBeNull();
      // The agent made these rulings itself: nothing is prompted back to it.
      expect(canvas.prompts).toHaveLength(0);
    });

    test("council_rule refuses an unknown finding, a bad decision and a review without its verdict", async () => {
      const { host, context, review } = await completed();
      const known = review().findings.map(({ id }) => id).join(", ");
      const rule = (input: unknown) => asyncRun(() => host.tools.council_rule!.run(input, context));
      await expect(rule({ finding: "F999", decision: "accepted" })).rejects.toThrow(`Review rev1 has no finding F999; its findings are ${known}.`);
      await expect(rule({ finding: "F1", decision: "maybe" })).rejects.toThrow("decision");
      await expect(rule({ finding: "F1" })).rejects.toThrow("decision");
      await expect(rule({ review: "nope", finding: "F1", decision: "accepted" })).rejects.toThrow("No review nope");

      const running = setup();
      await running.host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, running.context);
      const id = running.canvas.items[0]!.id;
      await running.host.action!(running.canvas.item(id), { kind: "start" }, running.context);
      while (running.canvas.item(id).data.findings.length === 0) await running.clock.step();
      const early = running.canvas.item(id).data.findings[0]!.id;
      await expect(asyncRun(() => running.host.tools.council_rule!.run({ finding: early, decision: "accepted" }, running.context))).rejects.toThrow("once the council has its verdict");
      await running.host.tools.council_stop!.run({}, running.context);
    });

    test("council_rule taking a finding out of the fixes says so, and names the fixer that won't hear", async () => {
      const env = await completed();
      env.canvas.settings.fixer = "pi home";
      const ids = standing(env.review()).map(({ id }) => id);
      expect(ids.length).toBeGreaterThan(1);
      for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "fix" });
      await env.host.tools.council_delegate_fix!.run({}, env.context);
      const prompts = env.canvas.prompts.length;
      const said = await env.host.tools.council_rule!.run({ finding: ids[0]!, decision: "dismissed", note: "not a problem" }, env.context);
      expect(said).toStartWith(`Dismissed ${ids[0]} in review rev1. It is out of the fixes now: don't fix it`);
      expect(said).toContain(`It was handed to the "pi home" profile, whose conversation can't hear this; its report on ${ids[0]} will be ignored.`);
      expect(env.review().findings.find((it) => it.id === ids[0])!.fix).toBeNull();
      expect(env.review().findings.find((it) => it.id === ids[1])!.fix?.state).toBe("handed-off");
      expect(env.canvas.prompts).toHaveLength(prompts);
    });

    test("a hand-off needs an accepted finding, then is written to the target's .spectra-council folder and recorded", async () => {
      const { review, act, written } = await completed();
      await expect(act({ kind: "handoff" })).rejects.toThrow("Accept at least one finding");
      expect(written).toHaveLength(0);
      const ids = standing(review()).map(({ id }) => id);
      for (const findingId of ids) await act({ kind: "rule", findingId, decision: "accepted" });
      await act({ kind: "handoff" });
      expect(written).toHaveLength(1);
      expect(written[0]!.path).toBe(join(target, ".spectra-council", `review-${review().id}.md`));
      for (const findingId of ids) expect(written[0]!.text).toContain(findingId);
      expect(review().handoff!.path).toBe(written[0]!.path);
      expect([...review().handoff!.findingIds].sort()).toEqual([...ids].sort());
    });

    test("the hand-off of a target document goes next to it", async () => {
      const doc = join(target, "README.md");
      const env = setup();
      await env.host.tools.council_open!.run({ target: doc, agents: ["mock-claude", "mock-codex"] }, env.context);
      const id = env.canvas.items[0]!.id;
      await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
      await env.clock.runAll();
      await env.clock.settle();
      const first = standing(env.canvas.item(id).data)[0];
      if (!first) return; // a small document may leave nothing standing
      await env.host.action!(env.canvas.item(id), { kind: "rule", findingId: first.id, decision: "accepted" }, env.context);
      await env.host.action!(env.canvas.item(id), { kind: "handoff" }, env.context);
      expect(env.written[0]!.path).toBe(join(target, ".spectra-council", `review-${env.canvas.item(id).data.id}.md`));
    });

    async function handedOff() {
      const env = await completed();
      const ids = standing(env.review()).map(({ id }) => id);
      for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "fix" });
      return { ...env, ids };
    }

    test("fix writes the hand-off, marks the findings handed off and prompts the agent after its turn", async () => {
      const { review, canvas, written, ids } = await handedOff();
      expect(written).toHaveLength(1);
      expect(review().findings.filter((it) => it.fix).map((it) => [it.id, it.fix!.state])).toEqual(ids.map((id) => [id, "handed-off"]));
      expect(canvas.prompts).toHaveLength(1);
      expect(canvas.promptOptions[0]).toEqual({ afterTurn: true });
      for (const id of ids) expect(canvas.prompts[0]).toContain(id);
      expect(canvas.prompts[0]).toContain(review().handoff!.path);
      expect(canvas.prompts[0]).toContain("council_mark_fixed");
    });

    test("fix rewrites a stale hand-off when the accepted findings changed", async () => {
      const env = await completed();
      const ids = standing(env.review()).map(({ id }) => id);
      expect(ids.length).toBeGreaterThan(1);
      await env.act({ kind: "rule", findingId: ids[0]!, decision: "accepted" });
      await env.act({ kind: "handoff" });
      expect(env.written).toHaveLength(1);
      await env.act({ kind: "rule", findingId: ids[1]!, decision: "accepted" });
      await env.act({ kind: "fix" });
      expect(env.written).toHaveLength(2);
      expect(env.review().handoff!.findingIds).toEqual(expect.arrayContaining([ids[0]!, ids[1]!]));
      expect(env.canvas.prompts[0]).toContain(ids[1]!);
    });

    test("fix uses a current hand-off as it is, and refuses when nothing is left to fix", async () => {
      const env = await completed();
      const ids = standing(env.review()).map(({ id }) => id);
      for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "handoff" });
      await env.act({ kind: "fix" });
      expect(env.written).toHaveLength(1);
      for (const findingId of ids) await env.host.tools.council_mark_fixed!.run({ finding: findingId, summary: "done", files: [] }, env.context);
      await expect(env.act({ kind: "fix" })).rejects.toThrow("fixed already");
    });

    test("fix without an accepted finding is refused", async () => {
      const { act, canvas } = await completed();
      await expect(act({ kind: "fix" })).rejects.toThrow("Accept at least one finding");
      expect(canvas.prompts).toHaveLength(0);
    });

    test("council_mark_fixed marks a finding fixed and says what is still open", async () => {
      const { host, review, context, ids } = await handedOff();
      expect(ids.length).toBeGreaterThan(1);
      const answer = await host.tools.council_mark_fixed!.run({ finding: ids[0]!, summary: "Changed the loop", files: ["src/a.ts"] }, context);
      expect(answer).toContain(`Marked ${ids[0]} fixed`);
      for (const id of ids.slice(1)) expect(answer).toContain(id);
      expect(answer).toContain("Still to fix");
      expect(review().findings.find((it) => it.id === ids[0])!.fix).toMatchObject({ state: "fixed", summary: "Changed the loop", files: ["src/a.ts"] });
      let last = "";
      for (const id of ids.slice(1)) last = (await host.tools.council_mark_fixed!.run({ finding: id, summary: "ok" }, context)) as string;
      expect(last).toContain("Every handed-off finding is fixed");
      expect(host.items.council!.outcome!(review())).toBe(`fixes: 0 verified, ${ids.length} open`);
    });

    test("council_mark_fixed refuses a finding not handed off, an unknown one and bad input", async () => {
      const env = await completed();
      const [first, second] = standing(env.review());
      await env.act({ kind: "rule", findingId: first!.id, decision: "accepted" });
      await env.act({ kind: "fix" });
      const fixed = env.host.tools.council_mark_fixed!;
      await expect(asyncRun(() => fixed.run({ finding: second!.id, summary: "x", files: [] }, env.context))).rejects.toThrow("wasn't handed off");
      await expect(asyncRun(() => fixed.run({ finding: "F999", summary: "x", files: [] }, env.context))).rejects.toThrow("no finding F999");
      await expect(asyncRun(() => fixed.run({ finding: first!.id, files: [] }, env.context))).rejects.toThrow("summary");
      await expect(asyncRun(() => fixed.run({ review: "nope", finding: first!.id, summary: "x", files: [] }, env.context))).rejects.toThrow("No review nope");
    });

    test("council_mark_fixed before the review is complete is refused", async () => {
      const { host, canvas, context, clock } = setup();
      await host.tools.council_open!.run({ target, agents: ["mock-claude", "mock-codex"] }, context);
      await expect(asyncRun(() => host.tools.council_mark_fixed!.run({ finding: "F1", summary: "x", files: [] }, context))).rejects.toThrow();
      await host.action!(canvas.items[0]!, { kind: "start" }, context);
      await clock.step();
      await expect(asyncRun(() => host.tools.council_mark_fixed!.run({ finding: "F1", summary: "x", files: [] }, context))).rejects.toThrow();
      await host.action!(canvas.items[0]!, { kind: "stop" }, context);
    });

    test("verify needs a complete review with a fixed finding", async () => {
      const env = await completed();
      await expect(env.act({ kind: "verify" })).rejects.toThrow("No finding has a fix");
      const [first] = standing(env.review());
      await env.act({ kind: "rule", findingId: first!.id, decision: "accepted" });
      await env.act({ kind: "fix" });
      await expect(env.act({ kind: "verify" })).rejects.toThrow("No finding has a fix");
    });

    test("verify says why when no reviewer is left to re-check a fix", async () => {
      const env = await completed();
      const [first] = standing(env.review());
      await env.act({ kind: "rule", findingId: first!.id, decision: "accepted" });
      await env.act({ kind: "fix" });
      await env.host.tools.council_mark_fixed!.run({ finding: first!.id, summary: "done", files: ["src/a.ts"] }, env.context);
      // Every reviewer failed in a later round: none who completed the review is left.
      const data = env.review();
      env.canvas.context().change(env.id, { data: { ...data, reviewers: data.reviewers.map((reviewer) => ({ ...reviewer, status: "failed" as const })) } });
      await expect(env.act({ kind: "verify" })).rejects.toThrow(`No reviewer who completed the review is left to re-check ${first!.id}'s fix`);
      await expect(env.host.tools.council_begin!.run({}, env.context)).rejects.toThrow("No reviewer who completed the review");
      expect(env.review().phase).toBe("complete");
      expect(env.review().verifications).toBe(0);
    });

    test("verify runs a round, settles the fixes, shows fix counts, and the agent is told again", async () => {
      const env = await completed();
      const { host, canvas, context, clock, review, act } = env;
      // The verdict's prompt told this conversation and marked the review heard: nothing waits on the note.
      expect(host.note!(context)).toBeNull();

      const ids = standing(review()).map(({ id }) => id);
      for (const findingId of ids) await act({ kind: "rule", findingId, decision: "accepted" });
      await act({ kind: "fix" });
      for (const id of ids) await host.tools.council_mark_fixed!.run({ finding: id, summary: "done", files: ["src/a.ts"] }, context);
      expect(host.note!(context)).toBeNull();

      await act({ kind: "verify" });
      await clock.step();
      expect(review().phase).toBe("verification");
      expect(host.items.council!.outcome!(review())).toBe("re-checking fixes");
      await clock.runAll();
      await clock.settle();

      const after = review();
      expect(after.phase).toBe("complete");
      expect(after.verifications).toBe(1);
      for (const id of ids) {
        const fix = after.findings.find((it) => it.id === id)!.fix!;
        expect(fix.state === "verified" || fix.state === "reopened").toBe(true);
        expect(fix.checks.length).toBeGreaterThan(0);
        expect(fix.checks.every((check) => check.pass === 1)).toBe(true);
      }
      expect(after.reviewers.filter((reviewer) => reviewer.enabled).every((reviewer) => reviewer.status === "completed")).toBe(true);
      const verified = after.findings.filter((it) => it.fix?.state === "verified").length;
      const reopened = after.findings.filter((it) => it.fix?.state === "reopened").length;
      const text = host.items.council!.outcome!(after) as string;
      expect(text).toStartWith("fixes: ");
      expect(text).toContain(`${verified} verified`);
      if (reopened > 0) expect(text).toContain(`${reopened} reopened`);

      // The re-check's verdict is told the same way, once, with how the fixes came out, and hears nothing left over on the note.
      const told = canvas.prompts.filter((text) => text.includes("is finished"));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(`(${text})`);
      expect(host.note!(context)).toBeNull();
    });

    test("fix after a reopening rewrites the hand-off with the re-check feedback and keeps the warning", async () => {
      const env = await completed();
      const { host, context, clock, review, act, canvas, written } = env;
      const ids = standing(review()).map(({ id }) => id);
      for (const findingId of ids) await act({ kind: "rule", findingId, decision: "accepted" });
      await act({ kind: "fix" });
      // Asked again with nothing new, nothing changes hands and the file stays as it is.
      await expect(act({ kind: "fix" })).rejects.toThrow("Nothing new to fix");
      expect(written).toHaveLength(1);
      for (const id of ids) await host.tools.council_mark_fixed!.run({ finding: id, summary: "done", files: ["src/a.ts"] }, context);
      await act({ kind: "verify" });
      await clock.step();
      await clock.runAll();
      await clock.settle();
      const reopened = review().findings.filter((it) => it.fix?.state === "reopened");
      expect(reopened.length).toBeGreaterThan(0);
      const before = written.length;
      await act({ kind: "fix" });
      expect(written).toHaveLength(before + 1);
      const text = written.at(-1)!.text;
      expect(text).toContain("### Fix status");
      expect(text).toContain("What was wrong with it:");
      for (const finding of reopened) expect(text).toContain(finding.fix!.checks.find((check) => check.outcome === "reopened")!.text);
      // Asked again with nothing changed, the file stays as it is.
      await expect(act({ kind: "fix" })).rejects.toThrow("Nothing new to fix");
      expect(written).toHaveLength(before + 1);
      void canvas;
    });

    test("stopping a verification round returns to complete with the fixes unsettled", async () => {
      const env = await completed();
      const ids = standing(env.review()).map(({ id }) => id);
      for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "fix" });
      for (const id of ids) await env.host.tools.council_mark_fixed!.run({ finding: id, summary: "done", files: [] }, env.context);
      await env.act({ kind: "verify" });
      await env.clock.step();
      expect(env.review().phase).toBe("verification");
      await env.act({ kind: "stop" });
      await env.clock.runAll();
      await env.clock.settle();
      expect(env.review().phase).toBe("complete");
      expect(env.review().findings.filter((it) => it.fix).every((it) => it.fix!.state === "fixed")).toBe(true);
    });

    test("council_stop stops a running re-check of the fixes, which leaves the review complete", async () => {
      const env = await completed();
      const ids = standing(env.review()).map(({ id }) => id);
      for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "fix" });
      for (const id of ids) await env.host.tools.council_mark_fixed!.run({ finding: id, summary: "done", files: [] }, env.context);
      await env.act({ kind: "verify" });
      await env.clock.step();
      expect(env.review().phase).toBe("verification");
      expect(await env.host.tools.council_stop!.run({}, env.context)).toBe("Stopped the re-check of the fixes of review rev1.");
      await env.clock.runAll();
      await env.clock.settle();
      expect(env.review().phase).toBe("complete");
      expect(env.review().findings.filter((it) => it.fix).every((it) => it.fix!.state === "fixed")).toBe(true);
    });

    test("a fix reported while a re-check runs survives it", async () => {
      const env = await completed();
      const [checked, other] = standing(env.review()).map(({ id }) => id);
      for (const findingId of [checked!, other!]) await env.act({ kind: "rule", findingId, decision: "accepted" });
      await env.act({ kind: "fix" });
      await env.host.tools.council_mark_fixed!.run({ finding: checked!, summary: "done", files: [] }, env.context);
      await env.act({ kind: "verify" });
      await env.clock.step();
      expect(env.review().phase).toBe("verification");
      const answer = await env.host.tools.council_mark_fixed!.run({ finding: other!, summary: "later", files: ["src/b.ts"] }, env.context);
      expect(answer).toContain(`Marked ${other} fixed`);
      await env.clock.runAll();
      await env.clock.settle();
      expect(env.review().phase).toBe("complete");
      expect(env.review().findings.find((it) => it.id === other)!.fix).toMatchObject({ state: "fixed", summary: "later", files: ["src/b.ts"] });
      expect(env.review().findings.find((it) => it.id === checked)!.fix!.checks.length).toBeGreaterThan(0);
    });

    describe("a fixer profile", () => {
      test("a fixer's reply that comes while a re-check runs survives it", async () => {
        const env = await completed();
        env.canvas.settings.fixer = "codex";
        const [checked, other] = standing(env.review()).map(({ id }) => id);
        for (const findingId of [checked!, other!]) await env.act({ kind: "rule", findingId, decision: "accepted" });
        await env.act({ kind: "fix" });
        await env.host.tools.council_mark_fixed!.run({ finding: checked!, summary: "done", files: [] }, env.context);
        await env.host.tools.council_delegate_fix!.run({}, env.context);
        await env.act({ kind: "verify" });
        await env.clock.step();
        expect(env.review().phase).toBe("verification");
        const text = "Done.\n```json\n" + JSON.stringify({ fixed: [{ finding: other, summary: "by codex", files: ["src/c.ts"] }] }) + "\n```";
        await env.host.replied!({ id: "conversation-fixer-1", profile: "codex" }, { ended: "finished", text }, env.context);
        await env.clock.runAll();
        await env.clock.settle();
        expect(env.review().phase).toBe("complete");
        expect(env.review().findings.find((it) => it.id === other)!.fix).toMatchObject({ state: "fixed", summary: "by codex" });
      });

      async function delegated() {
        const env = await completed();
        env.canvas.settings.fixer = "codex";
        const ids = standing(env.review()).map(({ id }) => id);
        for (const findingId of ids) await env.act({ kind: "rule", findingId, decision: "accepted" });
        await env.act({ kind: "fix" });
        return { ...env, ids };
      }

      const fixOf = (review: Review, id: string) => review.findings.find((it) => it.id === id)!.fix!;

      test("the fixer action returns the setting, or null", async () => {
        const { act, canvas } = await completed();
        expect(await act({ kind: "fixer" })).toEqual({ profile: null });
        canvas.settings.fixer = "codex";
        expect(await act({ kind: "fixer" })).toEqual({ profile: "codex" });
      });

      test("fix with a fixer marks the findings and asks the agent to call council_delegate_fix", async () => {
        const { review, canvas, ids } = await delegated();
        for (const id of ids) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off", fixer: { profile: "codex", conversationId: null } });
        expect(canvas.prompts).toHaveLength(1);
        expect(canvas.promptOptions[0]).toEqual({ afterTurn: true });
        expect(canvas.prompts[0]).toContain("council_delegate_fix");
        expect(canvas.prompts[0]).toContain("codex");
        expect(canvas.prompts[0]).not.toContain("council_mark_fixed");
        expect(canvas.started).toHaveLength(0);
      });

      test("council_delegate_fix starts a conversation with the hand-off and records it", async () => {
        const { host, review, canvas, context, ids } = await delegated();
        const answer = await host.tools.council_delegate_fix!.run({}, context);
        expect(canvas.started).toHaveLength(1);
        expect(canvas.started[0]!.profile).toBe("codex");
        expect(canvas.started[0]!.prompt).toContain(review().handoff!.path);
        for (const id of ids) expect(canvas.started[0]!.prompt).toContain(id);
        expect(answer).toContain("codex");
        for (const id of ids) expect(fixOf(review(), id).fixer).toEqual({ profile: "codex", conversationId: "conversation-fixer-1" });
      });

      test("council_delegate_fix errors when nothing waits for a fixer, or twice", async () => {
        const env = await handedOff();
        await expect(asyncRun(() => env.host.tools.council_delegate_fix!.run({}, env.context))).rejects.toThrow("waits for a fixer");
        const withFixer = await delegated();
        await withFixer.host.tools.council_delegate_fix!.run({}, withFixer.context);
        await expect(asyncRun(() => withFixer.host.tools.council_delegate_fix!.run({}, withFixer.context))).rejects.toThrow("waits for a fixer");
        expect(withFixer.canvas.started).toHaveLength(1);
      });

      const started = { id: "conversation-fixer-1", profile: "codex" };
      const report = (value: unknown) => "Done.\n```json\n" + JSON.stringify(value) + "\n```";

      test("a finished reply with a report marks fixed, failed and unmentioned findings", async () => {
        const { host, review, context, ids } = await delegated();
        expect(ids.length).toBeGreaterThan(2);
        await host.tools.council_delegate_fix!.run({}, context);
        const [fixed, failed, silent] = ids;
        await host.replied!(
          started,
          { ended: "finished", text: report({ fixed: [{ finding: fixed, summary: "Changed it", files: ["src/a.ts"] }], notFixed: [{ finding: failed, reason: "Too risky" }] }) },
          context,
        );
        expect(fixOf(review(), fixed!)).toMatchObject({ state: "fixed", summary: "Changed it", files: ["src/a.ts"], problem: null });
        expect(fixOf(review(), failed!)).toMatchObject({ state: "handed-off", problem: "codex: Too risky" });
        expect(fixOf(review(), silent!)).toMatchObject({ state: "handed-off", problem: "codex didn't report on it." });
      });

      test("a finished reply without a report fails all its findings", async () => {
        const { host, review, canvas, context, ids } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        await host.replied!(started, { ended: "finished", text: "All done, honest." }, context);
        for (const id of ids) expect(fixOf(review(), id).problem).toContain("without the JSON report");
        expect(canvas.prompts.at(-1)).toContain("ended without the JSON report");
      });

      test("a fixer's finished reply tells the review's conversation once what it fixed and what it didn't", async () => {
        const { host, review, canvas, context, ids } = await delegated();
        expect(ids.length).toBeGreaterThan(2);
        await host.tools.council_delegate_fix!.run({}, context);
        const before = canvas.prompts.length;
        const [fixed, failed, silent] = ids;
        await host.replied!(
          started,
          { ended: "finished", text: report({ fixed: [{ finding: fixed, summary: "Changed it", files: ["src/a.ts"] }], notFixed: [{ finding: failed, reason: "Too risky" }] }) },
          context,
        );
        expect(canvas.prompts).toHaveLength(before + 1);
        expect(canvas.promptOptions.at(-1)).toEqual({ afterTurn: true });
        const told = canvas.prompts.at(-1)!;
        expect(told).toContain(`Spectra Council review ${review().id}`);
        expect(told).toContain('the fixer conversation on the "codex" profile is back');
        expect(told).toContain(`It fixed ${fixed}.`);
        expect(told).toContain(`${failed}: Too risky`);
        expect(told).toContain(`${silent}: codex didn't report on it`);
        expect(told).toMatch(/didn't report on it\. Tell the user/);
        expect(told).toContain("Tell the user in one or two lines what came of it, without calling any council tool.");
      });

      test("the tell of an ask names the beads issues the fixer filed", async () => {
        const { host, review, canvas, context, act } = await completed();
        canvas.settings.fixer = "codex";
        const second = standing(review())[1]!.id;
        await act({ kind: "rule", findingId: second, decision: "accepted" });
        await act({ kind: "ask", text: "File beads issues for what you can't fix", toFixer: true });
        await host.tools.council_delegate_fix!.run({}, context);
        const before = canvas.prompts.length;
        await host.replied!(started, { ended: "finished", text: report({ tickets: [{ finding: second, ticket: "proj-a1b" }] }) }, context);
        expect(canvas.prompts).toHaveLength(before + 1);
        expect(canvas.prompts.at(-1)).toContain(`It filed proj-a1b for ${second}.`);
        expect(review().findings.find((it) => it.id === second)!.ticket?.id).toBe("proj-a1b");
      });

      test("a fixer report that couldn't be recorded is named in the telling, not dropped", async () => {
        const { host, review, canvas, context, act, clock, ids } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        const [checked, other] = ids;
        await host.tools.council_mark_fixed!.run({ finding: checked!, summary: "done", files: [] }, context);
        await act({ kind: "verify" });
        await clock.step();
        expect(review().phase).toBe("verification");
        const before = canvas.prompts.length;
        await host.replied!(
          started,
          { ended: "finished", text: report({ fixed: [{ finding: checked!, summary: "again", files: [] }, { finding: other!, summary: "x", files: [] }] }) },
          context,
        );
        const told = canvas.prompts.slice(before).join("\n");
        expect(told).toContain("Part of codex's report wasn't recorded:");
        expect(told).toContain("being re-checked");
        expect(told).toContain(`It fixed ${other}.`);
        expect(canvas.prompts).toHaveLength(before + 1);
      });

      test("a fixer's reply is recorded without waiting for the turn its telling starts", async () => {
        const { host, review, context, ids } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        const turnGoesOn = { ...context, prompt: () => new Promise<void>(() => {}) };
        await host.replied!(started, { ended: "finished", text: report({ fixed: [{ finding: ids[0], summary: "x" }] }) }, turnGoesOn);
        expect(fixOf(review(), ids[0]!).state).toBe("fixed");
      });

      test("a tell whose conversation was deleted is logged, not thrown", async () => {
        const { host, review, context, clock, ids } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        const gone = { ...context, prompt: async () => { throw new Error("The conversation is gone."); } };
        const logged: unknown[][] = [];
        const real = console.error;
        console.error = (...args: unknown[]) => logged.push(args);
        try {
          await host.replied!(started, { ended: "finished", text: report({ fixed: [{ finding: ids[0], summary: "x" }] }) }, gone);
          await clock.settle();
        } finally {
          console.error = real;
        }
        expect(fixOf(review(), ids[0]!).state).toBe("fixed");
        expect(logged.map((args) => String(args[0])).some((text) => text.includes("couldn't be told"))).toBe(true);
      });

      test("a stopped or failed reply fails all its findings, even with a report in its text", async () => {
        for (const ended of ["stopped", "failed"] as const) {
          const { host, review, context, ids } = await delegated();
          await host.tools.council_delegate_fix!.run({}, context);
          await host.replied!(started, { ended, text: report({ fixed: [{ finding: ids[0], summary: "x" }] }) }, context);
          for (const id of ids) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off" });
          for (const id of ids) expect(fixOf(review(), id).problem).toContain(ended === "stopped" ? "was stopped" : "failed");
        }
      });

      test("a reply for an unknown conversation changes nothing and tells no one", async () => {
        const { host, review, canvas, context } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        const before = JSON.stringify(review());
        const prompted = canvas.prompts.length;
        await host.replied!({ id: "other", profile: "codex" }, { ended: "finished", text: null }, context);
        expect(JSON.stringify(review())).toBe(before);
        expect(canvas.prompts).toHaveLength(prompted);
      });

      test("a failed finding is handed to this conversation's agent by a later fix without a fixer", async () => {
        const { host, review, canvas, context, act, ids } = await delegated();
        await host.tools.council_delegate_fix!.run({}, context);
        await host.replied!(started, { ended: "failed", text: null }, context);
        expect(fixOf(review(), ids[0]!).problem).not.toBeNull();
        canvas.settings.fixer = null;
        await act({ kind: "fix" });
        for (const id of ids) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off", fixer: null, problem: null });
        expect(canvas.prompts.at(-1)).toContain("council_mark_fixed");
        expect(canvas.prompts.at(-1)).not.toContain("council_delegate_fix");
      });

      /** Whether a fixer conversation's first message lists this finding to fix. */
      const lists = (prompt: string, id: string) => prompt.includes(`\n- ${id}: `);

      test("accepting another finding while a fixer works hands the next fixer only that one, and both reports count", async () => {
        const env = await completed();
        env.canvas.settings.fixer = "codex";
        const [first, second] = standing(env.review()).map(({ id }) => id) as [string, string];
        await env.act({ kind: "rule", findingId: first, decision: "accepted" });
        await env.act({ kind: "fix" });
        await env.host.tools.council_delegate_fix!.run({}, env.context);
        expect(fixOf(env.review(), first).fixer).toEqual({ profile: "codex", conversationId: "conversation-fixer-1" });

        await env.act({ kind: "rule", findingId: second, decision: "accepted" });
        await env.act({ kind: "fix" });
        expect(env.canvas.prompts.at(-1)).toContain(`handed ${second} from`);
        expect(fixOf(env.review(), first)).toMatchObject({ fixer: { profile: "codex", conversationId: "conversation-fixer-1" }, problem: null });
        expect(fixOf(env.review(), second).fixer).toEqual({ profile: "codex", conversationId: null });

        await env.host.tools.council_delegate_fix!.run({}, env.context);
        expect(env.canvas.started).toHaveLength(2);
        expect(lists(env.canvas.started[1]!.prompt, second)).toBe(true);
        expect(lists(env.canvas.started[1]!.prompt, first)).toBe(false);
        expect(fixOf(env.review(), first).fixer!.conversationId).toBe("conversation-fixer-1");
        expect(fixOf(env.review(), second).fixer!.conversationId).toBe("conversation-fixer-2");

        await env.host.replied!(started, { ended: "finished", text: report({ fixed: [{ finding: first, summary: "First", files: [] }] }) }, env.context);
        await env.host.replied!({ id: "conversation-fixer-2", profile: "codex" }, { ended: "finished", text: report({ fixed: [{ finding: second, summary: "Second", files: [] }] }) }, env.context);
        expect(fixOf(env.review(), first)).toMatchObject({ state: "fixed", summary: "First" });
        expect(fixOf(env.review(), second)).toMatchObject({ state: "fixed", summary: "Second" });
      });

      test("asking again while the work is pending starts nothing new", async () => {
        const { host, canvas, context, act, review, ids } = await delegated();
        await expect(act({ kind: "fix" })).rejects.toThrow("with the fixer already");
        await host.tools.council_delegate_fix!.run({}, context);
        await expect(act({ kind: "fix" })).rejects.toThrow("with the fixer already");
        await expect(asyncRun(() => host.tools.council_delegate_fix!.run({}, context))).rejects.toThrow("waits for a fixer");
        expect(canvas.started).toHaveLength(1);
        expect(canvas.prompts).toHaveLength(1);
        for (const id of ids) expect(fixOf(review(), id).fixer).toEqual({ profile: "codex", conversationId: "conversation-fixer-1" });
        // This conversation's agent keeps its work too.
        const chair = await handedOff();
        await expect(chair.act({ kind: "fix" })).rejects.toThrow("with the fixer already");
        expect(chair.canvas.prompts).toHaveLength(1);
      });

      test("asking while the fixer's conversation starts hands out only the new work, once it has started", async () => {
        const env = await completed();
        env.canvas.settings.fixer = "codex";
        const [first, second] = standing(env.review()).map(({ id }) => id) as [string, string];
        await env.act({ kind: "rule", findingId: first, decision: "accepted" });
        await env.act({ kind: "fix" });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slow = { ...env.context, startConversation: async (start: { profile: string; prompt: string }) => (await gate, env.context.startConversation(start)) };
        const starting = env.host.tools.council_delegate_fix!.run({}, slow);

        await expect(env.act({ kind: "fix" })).rejects.toThrow("with the fixer already");
        await env.act({ kind: "rule", findingId: second, decision: "accepted" });
        await env.act({ kind: "fix" });
        expect(fixOf(env.review(), first).fixer).toEqual({ profile: "codex", conversationId: null });
        expect(fixOf(env.review(), second).fixer).toEqual({ profile: "codex", conversationId: null });
        await expect(asyncRun(() => env.host.tools.council_delegate_fix!.run({}, env.context))).rejects.toThrow("being started");

        release();
        await starting;
        expect(fixOf(env.review(), first).fixer!.conversationId).toBe("conversation-fixer-1");
        expect(fixOf(env.review(), second).fixer!.conversationId).toBeNull();
        await env.host.tools.council_delegate_fix!.run({}, env.context);
        expect(env.canvas.started).toHaveLength(2);
        expect(lists(env.canvas.started[1]!.prompt, second)).toBe(true);
        expect(lists(env.canvas.started[1]!.prompt, first)).toBe(false);
        expect(fixOf(env.review(), first).fixer!.conversationId).toBe("conversation-fixer-1");
        expect(fixOf(env.review(), second).fixer!.conversationId).toBe("conversation-fixer-2");
      });

      test("a fixer conversation that can't start fails its findings, so asking again hands them to the fixer chosen then", async () => {
        const { host, review, canvas, context, act, ids } = await delegated();
        const broken = { ...context, startConversation: async () => Promise.reject(new Error("No profile codx")) };
        await expect(host.tools.council_delegate_fix!.run({}, broken)).rejects.toThrow("No profile codx");
        for (const id of ids) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off", problem: "Couldn't start a conversation on codex: No profile codx" });
        canvas.settings.fixer = "claude";
        await act({ kind: "fix" });
        for (const id of ids) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off", fixer: { profile: "claude", conversationId: null }, problem: null });
        await host.tools.council_delegate_fix!.run({}, context);
        expect(canvas.started.at(-1)!.profile).toBe("claude");
      });

      test("a retry hands only the failed findings to a new conversation, and the old one's late report is ignored", async () => {
        const { host, review, canvas, context, act, ids } = await delegated();
        const [done, failed, ...silent] = ids as [string, string, ...string[]];
        await host.tools.council_delegate_fix!.run({}, context);
        await host.replied!(started, { ended: "finished", text: report({ fixed: [{ finding: done, summary: "Done", files: [] }], notFixed: [{ finding: failed, reason: "Too risky" }] }) }, context);
        await act({ kind: "fix" });
        for (const id of [failed, ...silent]) expect(fixOf(review(), id)).toMatchObject({ state: "handed-off", fixer: { profile: "codex", conversationId: null }, problem: null });
        expect(fixOf(review(), done)).toMatchObject({ state: "fixed", summary: "Done" });

        await host.tools.council_delegate_fix!.run({}, context);
        expect(lists(canvas.started[1]!.prompt, done)).toBe(false);
        for (const id of [failed, ...silent]) expect(fixOf(review(), id).fixer!.conversationId).toBe("conversation-fixer-2");
        // The superseded attempt reports late: the retried work isn't its to settle.
        await host.replied!(started, { ended: "finished", text: report({ fixed: [{ finding: failed, summary: "Stale", files: [] }] }) }, context);
        expect(fixOf(review(), failed)).toMatchObject({ state: "handed-off", problem: null });
        await host.replied!({ id: "conversation-fixer-2", profile: "codex" }, { ended: "finished", text: report({ fixed: [{ finding: failed, summary: "Retried", files: [] }] }) }, context);
        expect(fixOf(review(), failed)).toMatchObject({ state: "fixed", summary: "Retried" });
      });
    });

    test("a format-2 review stored before rulings reads as complete with no fixes", async () => {
      const { host, canvas, context, review, id } = await completed();
      const { handoff: _h, verifications: _v, ...rest } = review();
      const old = { ...rest, format: 2, findings: review().findings.map(({ proposal: _p, ruling: _r, fix: _f, ...finding }) => finding) } as unknown as Review;
      canvas.items[canvas.items.findIndex((it) => it.id === id)] = { ...canvas.item(id), data: old };
      const listed = host.items.council!.listed!(canvas.item(id));
      expect(listed).toMatchObject({ format: 8, handoff: null, verifications: 0, phase: "complete" });
      expect(await host.tools.council_status!.run({}, context)).toContain(review().id);
    });
  });
});
