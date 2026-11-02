import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../core/model.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const target = await mkdtemp(join(tmpdir(), "spectra-target-"));
await writeFile(join(target, "README.md"), "# A project\n");

function setup() {
  const clock = new FakeClock();
  let ids = 0;
  const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0 });
  const canvas = new FakeCanvas<Review>();
  return { clock, host, canvas, context: canvas.context() };
}

describe("the Mirador host", () => {
  test("council_open publishes a review in setup", async () => {
    const { host, canvas, context } = setup();
    const answer = await host.tools.council_open!.run({ target, profile: "security", agents: ["mock-gemini"] }, context);
    expect(answer).toContain("Opened Spectra Council review rev1");
    const [item] = canvas.items;
    expect(item!.type).toBe("council");
    expect(item!.title).toStartWith("Security review · spectra-target-");
    expect(item!.data.phase).toBe("setup");
    expect(item!.data.reviewers.map((reviewer) => [reviewer.label, reviewer.enabled])).toEqual([
      ["Gemini", true],
      ["Codex", false],
      ["Gemini", false],
      ["Qwen", false],
    ]);
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

  test("the view configures and starts a review, which runs to completion and is noted for the agent once", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target }, context);
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
    expect(await host.tools.council_status!.run({}, context)).toContain(`${review.findings.length}`);

    const note = host.note!(context)!;
    expect(note.text).toContain("Spectra Council review rev1 ended (complete)");
    note.heard();
    expect(host.note!(context)).toBeNull();
  });

  test("stop from the view stops a running review", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    for (let i = 0; i < 3; i++) await clock.step();
    await host.action!(canvas.item(id), { kind: "stop" }, context);
    await clock.runAll();
    await clock.settle();
    expect(canvas.item(id).data.phase).toBe("stopped");
  });

  test("a review left running by an earlier Mirador shows as interrupted", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target }, context);
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
    await host.tools.council_open!.run({ target }, context);
    const id = canvas.items[0]!.id;
    await expect(host.action!(canvas.item(id), { kind: "dance" }, context)).rejects.toThrow("Unknown action");
    await host.action!(canvas.item(id), { kind: "configure", patch: { seats: Array.from({ length: 4 }, () => ({ agent: "mock-qwen", enabled: false })) } }, context);
    await expect(host.action!(canvas.item(id), { kind: "start" }, context)).rejects.toThrow("Seat at least one reviewer");
  });
});
