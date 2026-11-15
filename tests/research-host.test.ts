import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const workspace = await mkdtemp(join(tmpdir(), "spectra-research-"));
const brief = join(workspace, "brief.md");
await writeFile(brief, "# Brief\n\nRQ1. What is read?\n");

const source = { url: "https://example.org/paper", authors: "A. Author", title: "Paper", venue: "Venue", quote: "It reads series.", read: "full-text" as const };

/** Scripted researchers: each reports one fact on the same paper; checkers verify it; the editor cites what stands. */
const scripted: ReviewerRunner = {
  run: async () => {
    throw new Error("not a review");
  },
  deliberate: async () => {},
  propose: async () => {},
  verify: async () => {},
  research: async (job, report) => {
    const pass = job.review.research!.pass;
    report({ type: "claim-reported", claim: { rq: "RQ1", kind: "fact", title: `Reads series (${job.reviewer.id}, run ${pass})`, text: "Pipelines read whole series.", confidence: "high", sources: [source] } });
  },
  checkSources: async (job, report) => {
    for (const claimId of job.claimIds) report({ type: "source-checked", check: { claimId, source: 1, outcome: "verified", note: "Opened it." } });
  },
  draft: async (job, report) => {
    const ids = job.review.research!.claims.filter((claim) => ["agreed", "confirmed"].includes(claim.status) && claim.ruling?.decision !== "struck").map(({ id }) => `[${id}]`);
    report({ type: "answer-drafted", markdown: `# Answer\n\nSeries are read whole ${ids.join(" ")}.` });
  },
  checkDraft: async () => {},
};

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
    runnerFor: (agent) => (agent.startsWith("profile:") ? scripted : undefined),
  });
  const canvas = new FakeCanvas<Review>();
  return { clock, host, canvas, context: canvas.context(), written };
}

const play = async (clock: FakeClock) => {
  await clock.runAll();
  await clock.settle();
};

describe("research councils in the Mirador host", () => {
  test("council_open opens one with its brief, answer file and editor, and refuses what doesn't fit", async () => {
    const { host, canvas, context } = setup();
    const said = await host.tools.council_open!.run({ target: workspace, kind: "research", brief, agents: ["profile:a", { agent: "profile:b", focus: "RQ1" }], editor: "r2" }, context);
    expect(String(said)).toContain("research council");
    expect(String(said)).toContain(join(workspace, "brief-answer.md"));
    const review = canvas.items[0]!.data;
    expect(review).toMatchObject({ kind: "research", depth: "standard", deliberationRounds: 2, maxFindings: 30 });
    expect(review.research).toMatchObject({ brief, editor: "r2", question: "" });
    expect(review.reviewers[1]!.focus).toBe("RQ1");
    expect(canvas.items[0]!.title).toBe("Research · brief.md");

    await expect(host.tools.council_open!.run({ target: workspace, kind: "research" }, context)).rejects.toThrow("brief");
    await expect(host.tools.council_open!.run({ target: workspace, brief: join(workspace, "missing.md") }, context)).rejects.toThrow("no brief file");
    await expect(host.tools.council_open!.run({ target: workspace, kind: "review", brief }, context)).rejects.toThrow("research council's");
    await expect(host.tools.council_open!.run({ target: workspace, kind: "review", maxFindings: 30 }, context)).rejects.toThrow("1 to 20");
  });

  test("runs to one answer written to the answer file, and the conversation hears where", async () => {
    const { host, canvas, context, clock, written } = setup();
    await host.tools.council_open!.run({ target: workspace, brief, agents: ["profile:a", "profile:b"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await play(clock);
    const review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
        // Nobody argued, so each stands on its reporter's backing alone: confirmed, not agreed.
    expect(review.research!.claims.map((claim) => claim.status)).toEqual(["confirmed", "confirmed"]);
    expect(review.research!.written?.path).toBe(join(workspace, "brief-answer.md"));
    expect(written.at(-1)!.path).toBe(join(workspace, "brief-answer.md"));
    expect(written.at(-1)!.text).toContain("Series are read whole [C1] [C2].");
    expect(canvas.prompts.at(-1)).toContain("brief-answer.md");
  });

  test("a typed question is saved as the brief at the start", async () => {
    const { host, canvas, context, clock, written } = setup();
    await host.tools.council_open!.run({ target: workspace, question: "Which predicates are slice-level?", agents: ["profile:a", "profile:b"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await play(clock);
    const saved = join(workspace, ".spectra-council", "research-rev1-brief.md");
    expect(written[0]).toEqual({ path: saved, text: "# Research question\n\nWhich predicates are slice-level?\n" });
    expect(canvas.item(id).data.research!.brief).toBe(saved);
    expect(written.at(-1)!.path).toBe(join(workspace, ".spectra-council", "research-rev1-brief-answer.md"));
  });

  test("a follow-up runs again on the same ledger, and a strike gets a revised answer", async () => {
    const { host, canvas, context, clock, written } = setup();
    await host.tools.council_open!.run({ target: workspace, brief, agents: ["profile:a", "profile:b"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await play(clock);

    await host.action!(canvas.item(id), { kind: "follow-up", text: "Look at RSNA." }, context);
    await play(clock);
    let review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.research!.pass).toBe(1);
    expect(review.research!.claims.filter((claim) => claim.pass === 1)).toHaveLength(2);
    expect(written.at(-1)!.text).toContain("[C3] [C4]");

    await host.action!(canvas.item(id), { kind: "rule-claim", claimId: "C1", decision: "struck", note: "Not this paper." }, context);
    expect(canvas.item(id).data.research!.revisionDue).toBe(true);
    await host.action!(canvas.item(id), { kind: "revise" }, context);
    await play(clock);
    review = canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.research!.revisionDue).toBe(false);
    expect(review.research!.drafts.at(-1)!.markdown).not.toContain("[C1]");
    await expect(host.action!(canvas.item(id), { kind: "revise" }, context)).rejects.toThrow();
  });

  test("after a restart, a follow-up asks the agent to call council_begin, which runs it", async () => {
    const { host, canvas, context, clock } = setup();
    await host.tools.council_open!.run({ target: workspace, brief, agents: ["profile:a", "profile:b"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await play(clock);
    const restarted = createCouncilHost({ clock, listFiles: async () => FILES, throttleMs: 0, writeFile: async () => {}, runnerFor: (agent) => (agent.startsWith("profile:") ? scripted : undefined) });
    expect(await restarted.action!(canvas.item(id), { kind: "follow-up", text: "More." }, context)).toEqual({ prompted: true });
    expect(canvas.prompts.at(-1)).toContain("council_begin");
    expect(String(await restarted.tools.council_begin!.run({}, context))).toContain("follow-up");
    await play(clock);
    expect(canvas.item(id).data.research!.pass).toBe(1);
  });
});
