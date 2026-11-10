import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../core/model.ts";
import { awaitsFixRequest, newReview, reduce, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { askFixerPrompt, askPrompt, BEADS_PRIORITY, handoffRef, ticketsPrompt, unticketed, waitingTickets } from "../core/tickets.ts";
import { beadsWorkspace, createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const report = (title: string, severity: FindingInput["severity"]): FindingInput => ({ title, summary: `${title}.`, severity, confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 1 }] });

/** A completed review with F1 (low), F2 (critical) and F3 (medium); F1 and F2 accepted, F3 dismissed. */
function concluded(): Review {
  let review = newReview("rev1", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }] }, "mock", 0);
  const events: ReviewEvent[] = [
    { type: "started", at: 1 },
    { type: "reviewer-started", reviewerId: "r1", at: 2 },
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: report("Off by one", "low") },
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: report("Data loss on restart", "critical") },
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: report("Slow query", "medium") },
    { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" },
    { type: "concluded", at: 5, summary: "Done." },
    { type: "ruled", at: 6, findingId: "F1", decision: "accepted", note: "" },
    { type: "ruled", at: 6, findingId: "F2", decision: "accepted", note: "" },
    { type: "ruled", at: 6, findingId: "F3", decision: "dismissed", note: "" },
  ];
  for (const event of events) review = reduce(review, event);
  return review;
}

describe("tickets in the review", () => {
  test("asking for tickets marks the accepted findings, most severe first in unticketed", () => {
    const review = reduce(concluded(), { type: "tickets-requested", at: 10, findingIds: ["F1", "F2"] });
    expect(review.findings[0]!.ticket).toEqual({ id: null, requestedAt: 10, filedAt: null });
    expect(review.findings[2]!.ticket).toBeUndefined();
    expect(unticketed(concluded()).map(({ id }) => id)).toEqual(["F2", "F1"]);
    expect(unticketed(review)).toEqual([]);
    expect(waitingTickets(review).map(({ id }) => id)).toEqual(["F2", "F1"]);
  });

  test("a filed ticket shows on the finding and stays when tickets are asked for again", () => {
    let review = reduce(concluded(), { type: "tickets-requested", at: 10, findingIds: ["F1", "F2"] });
    review = reduce(review, { type: "ticketed", at: 11, findingId: "F2", ticket: " repo-a1b " });
    expect(review.findings[1]!.ticket).toEqual({ id: "repo-a1b", requestedAt: 10, filedAt: 11 });
    review = reduce(review, { type: "tickets-requested", at: 12, findingIds: ["F1", "F2"] });
    expect(review.findings[1]!.ticket?.id).toBe("repo-a1b");
    expect(review.findings[0]!.ticket).toEqual({ id: null, requestedAt: 12, filedAt: null });
    expect(waitingTickets(review).map(({ id }) => id)).toEqual(["F1"]);
  });

  test("tickets are only for accepted findings, after the verdict, with an id", () => {
    expect(() => reduce(concluded(), { type: "tickets-requested", at: 10, findingIds: ["F3"] })).toThrow("F3 isn't accepted");
    expect(() => reduce(concluded(), { type: "tickets-requested", at: 10, findingIds: [] })).toThrow("No accepted finding");
    expect(() => reduce(concluded(), { type: "ticketed", at: 10, findingId: "F3", ticket: "x-1" })).toThrow("F3 isn't accepted");
    expect(() => reduce(concluded(), { type: "ticketed", at: 10, findingId: "F1", ticket: "  " })).toThrow("issue id");
    // One nobody asked for is refused (it may be meant for another review), unless the user asked about the finding.
    expect(() => reduce(concluded(), { type: "ticketed", at: 10, findingId: "F1", ticket: "x-1" })).toThrow("No ticket was asked for F1");
    const asked = reduce(concluded(), { type: "asked", at: 9, text: "File them", findingIds: ["F1", "F2"] });
    expect(reduce(asked, { type: "ticketed", at: 10, findingId: "F1", ticket: "x-1" }).findings[0]!.ticket).toEqual({ id: "x-1", requestedAt: 10, filedAt: 10 });
    const running = reduce(newReview("r", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }] }, "mock", 0), { type: "started", at: 1 });
    expect(() => reduce(running, { type: "tickets-requested", at: 10, findingIds: ["F1"] })).toThrow("complete");
  });
});

describe("asks in the review", () => {
  test("an ask is kept with the accepted findings it was about", () => {
    let review = reduce(concluded(), { type: "asked", at: 10, text: "  Fix only the security ones  ", findingIds: ["F1", "F2"] });
    review = reduce(review, { type: "asked", at: 11, text: "Open a PR per finding", findingIds: ["F1", "F2"] });
    expect(review.asks).toEqual([
      { text: "Fix only the security ones", findingIds: ["F1", "F2"], at: 10 },
      { text: "Open a PR per finding", findingIds: ["F1", "F2"], at: 11 },
    ]);
  });

  test("an ask sent to the fixer profile waits for its conversation, then records how it ended", () => {
    let review = reduce(concluded(), { type: "asked", at: 10, text: "File them", findingIds: ["F1", "F2"] });
    review = reduce(review, { type: "asked", at: 11, text: "Fix them", findingIds: ["F1", "F2"], profile: " codex " });
    expect(review.asks![0]!.fixer).toBeUndefined();
    expect(review.asks![1]!.fixer).toEqual({ profile: "codex", conversationId: null, endedAt: null, problem: null });
    expect(() => reduce(review, { type: "ask-delegated", at: 12, ask: 0, conversationId: "c1" })).toThrow("was sent to a fixer profile");
    expect(() => reduce(review, { type: "ask-answered", at: 12, ask: 1, problem: null })).toThrow("no fixer conversation");
    review = reduce(review, { type: "ask-delegated", at: 12, ask: 1, conversationId: "c1" });
    expect(review.asks![1]!.fixer!.conversationId).toBe("c1");
    expect(() => reduce(review, { type: "ask-delegated", at: 12, ask: 1, conversationId: "c2" })).toThrow("started already");
    review = reduce(review, { type: "ask-answered", at: 13, ask: 1, problem: "It failed." });
    expect(review.asks![1]!.fixer).toEqual({ profile: "codex", conversationId: "c1", endedAt: 13, problem: "It failed." });
    expect(review.asks![0]).toEqual({ text: "File them", findingIds: ["F1", "F2"], at: 10 });
  });

  test("an ask whose fixer conversation couldn't start ends with why", () => {
    let review = reduce(concluded(), { type: "asked", at: 10, text: "File them", findingIds: ["F1"] });
    review = reduce(review, { type: "asked", at: 11, text: "Fix them", findingIds: ["F1"], profile: "codex" });
    expect(() => reduce(review, { type: "ask-failed", at: 12, ask: 0, problem: "x" })).toThrow("was sent to a fixer profile");
    const failed = reduce(review, { type: "ask-failed", at: 12, ask: 1, problem: "No profile codex." });
    expect(failed.asks![1]!.fixer).toEqual({ profile: "codex", conversationId: null, endedAt: 12, problem: "No profile codex." });
    expect(() => reduce(failed, { type: "ask-failed", at: 13, ask: 1, problem: "again" })).toThrow("isn't waiting to start");
    const started = reduce(review, { type: "ask-delegated", at: 12, ask: 1, conversationId: "c1" });
    expect(() => reduce(started, { type: "ask-failed", at: 13, ask: 1, problem: "x" })).toThrow("isn't waiting to start");
  });

  test("an empty ask, or one about findings not accepted, is refused", () => {
    expect(() => reduce(concluded(), { type: "asked", at: 10, text: " ", findingIds: ["F1"] })).toThrow("Say what");
    expect(() => reduce(concluded(), { type: "asked", at: 10, text: "Go", findingIds: ["F3"] })).toThrow("F3 isn't accepted");
  });

  test("a fix of an accepted finding nobody handed off counts only when the user asked about it", () => {
    expect(() => reduce(concluded(), { type: "fix-reported", at: 10, findingId: "F1", summary: "x", files: [] })).toThrow("wasn't handed off");
    const asked = reduce(concluded(), { type: "asked", at: 9, text: "Fix F1", findingIds: ["F1", "F2"] });
    const review = reduce(asked, { type: "fix-reported", at: 10, findingId: "F1", summary: "Fixed the bound.", files: ["src/a.ts"] });
    expect(review.findings[0]!.fix).toMatchObject({ state: "fixed", fixer: null, summary: "Fixed the bound.", files: ["src/a.ts"], fixedAt: 10 });
    expect(() => reduce(asked, { type: "fix-reported", at: 10, findingId: "F3", summary: "x", files: [] })).toThrow("wasn't handed off");
    // A fixed finding needs no ticket.
    expect(unticketed(review).map(({ id }) => id)).toEqual(["F2"]);
  });

  test("why a fixer didn't fix an accepted finding nobody handed off shows on it only when the user asked about it", () => {
    const unasked = reduce(concluded(), { type: "fix-failed", at: 10, findingIds: ["F1"], reason: "codex: no repro" });
    expect(unasked.findings[0]!.fix).toBeNull();
    const asked = reduce(concluded(), { type: "asked", at: 9, text: "Fix F1", findingIds: ["F1", "F2"], profile: "codex" });
    const review = reduce(asked, { type: "fix-failed", at: 10, findingIds: ["F1", "F3"], reason: "codex: no repro" });
    expect(review.findings[0]!.fix).toEqual({ state: "handed-off", handedOffAt: 10, fixer: null, problem: "codex: no repro", summary: null, files: [], fixedAt: null, checks: [] });
    // F3 was dismissed: not asked about, so nothing to show on.
    expect(review.findings[2]!.fix).toBeNull();
    expect(awaitsFixRequest(review.findings[0]!)).toBe(true);
    // A later report that it was fixed after all clears the problem.
    const fixed = reduce(review, { type: "fix-reported", at: 11, findingId: "F1", summary: "Fixed it.", files: ["src/a.ts"] });
    expect(fixed.findings[0]!.fix).toMatchObject({ state: "fixed", problem: null, summary: "Fixed it." });
  });

  test("a ticket waiting for the agent goes when the finding is no longer accepted; a filed one stays", () => {
    let review = reduce(concluded(), { type: "tickets-requested", at: 10, findingIds: ["F1", "F2"] });
    review = reduce(review, { type: "ticketed", at: 11, findingId: "F2", ticket: "repo-1" });
    review = reduce(review, { type: "ruled", at: 12, findingId: "F1", decision: "dismissed", note: "" });
    review = reduce(review, { type: "ruled", at: 12, findingId: "F2", decision: "deferred", note: "" });
    expect(review.findings[0]!.ticket).toBeNull();
    expect(review.findings[1]!.ticket?.id).toBe("repo-1");
    expect(waitingTickets(review)).toEqual([]);
  });
});

describe("the prompts", () => {
  test("tickets: one bd issue per finding, priority from severity, linked back, reported with council_mark_ticketed", () => {
    const prompt = ticketsPrompt(concluded(), ["F1", "F2"], "/repo/.spectra-council/review-rev1.md", "/repo");
    expect(prompt).toContain("beads workspace at /repo");
    expect(prompt.indexOf("- F2 (critical, beads priority 0)")).toBeLessThan(prompt.indexOf("- F1 (low, beads priority 3)"));
    expect(prompt).not.toContain("F3");
    expect(prompt).toContain("From Spectra Council review rev1, finding <id> (hand-off: .spectra-council/review-rev1.md)");
    expect(prompt).toContain('council_mark_ticketed with review "rev1"');
    expect(prompt).toContain('bd search --desc-contains "review rev1, finding <id>"');
    expect(prompt).toContain("Don't fix them now");
    expect(BEADS_PRIORITY.info).toBe(4);
  });

  test("tickets: the hand-off is named relative to the beads workspace, an outside one as it is", () => {
    expect(handoffRef("/home/u/repo/.spectra-council/review-x.md", "/home/u/repo")).toBe(".spectra-council/review-x.md");
    expect(handoffRef("/home/u/repo/sub/.spectra-council/review-x.md", "/home/u/repo/")).toBe("sub/.spectra-council/review-x.md");
    expect(handoffRef("/home/u/repo-two/.spectra-council/review-x.md", "/home/u/repo")).toBe("/home/u/repo-two/.spectra-council/review-x.md");
  });

  test("ask: the user's words quoted, with the accepted findings and the hand-off", () => {
    const prompt = askPrompt(concluded(), "Fix only the security ones\nand add tests", "/repo/h.md");
    expect(prompt).toContain("> Fix only the security ones\n> and add tests");
    expect(prompt).toContain("- F2 (critical");
    expect(prompt).not.toContain("F3");
    expect(prompt).toContain("/repo/h.md");
    expect(prompt).toContain('council_mark_fixed with review "rev1"');
  });

  test("ask to the fixer: titled, the user's words and the findings asked about, reported as JSON", () => {
    const review = reduce(concluded(), { type: "asked", at: 10, text: "File a ticket for each", findingIds: ["F1", "F2"], profile: "codex" });
    const prompt = askFixerPrompt(review, 0, "/repo/h.md");
    expect(prompt.split("\n")[0]).toBe("Spectra Council rev1 · Ask about F2, F1");
    expect(prompt).toContain("> File a ticket for each");
    expect(prompt.indexOf("- F2 (critical")).toBeLessThan(prompt.indexOf("- F1 (low"));
    expect(prompt).not.toContain("F3");
    expect(prompt).toContain("/repo/h.md");
    expect(prompt).toContain('"tickets": [');
    expect(prompt).not.toContain("council_mark_fixed");
    expect(() => askFixerPrompt(review, 1, "/repo/h.md")).toThrow("no ask 1");
  });
});

describe("the host", () => {
  test("beadsWorkspace finds the nearest beads workspace above, not a bare .beads or the home folder's", async () => {
    const root = await mkdtemp(join(tmpdir(), "spectra-beads-"));
    const nested = join(root, "repo", "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await beadsWorkspace(nested)).toBeNull();
    await mkdir(join(root, "repo", ".beads"));
    expect(await beadsWorkspace(nested)).toBeNull();
    await writeFile(join(root, "repo", ".beads", "metadata.json"), "{}");
    expect(await beadsWorkspace(nested)).toBe(join(root, "repo"));
    expect(await beadsWorkspace(join(root, "repo"))).toBe(join(root, "repo"));
    // bd keeps its own state in ~/.beads: not a workspace, even with a marker.
    expect(await beadsWorkspace(nested, join(root, "repo"))).toBeNull();
  });

  async function completed(withBeads: boolean) {
    const target = await mkdtemp(join(tmpdir(), "spectra-tickets-"));
    await writeFile(join(target, "README.md"), "# A project\n");
    if (withBeads) {
      await mkdir(join(target, ".beads"));
      await writeFile(join(target, ".beads", "config.yaml"), "");
    }
    const clock = new FakeClock();
    const written: string[] = [];
    const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => "rev1", throttleMs: 0, writeFile: async (path) => void written.push(path) });
    const canvas = new FakeCanvas<Review>();
    const context = canvas.context();
    await host.tools.council_open!.run({ target, agents: ["mock-claude"] }, context);
    const id = canvas.items[0]!.id;
    const act = (action: unknown) => host.action!(canvas.item(id), action, context);
    await act({ kind: "start" });
    await clock.runAll();
    await clock.settle();
    const review = () => canvas.item(id).data;
    for (const finding of review().findings) await act({ kind: "rule", findingId: finding.id, decision: "accepted" });
    return { target, host, canvas, context, act, review, written, clock };
  }

  test("tickets write the hand-off, mark the findings, prompt the agent, and council_mark_ticketed records each", async () => {
    const { target, host, canvas, context, act, review, written } = await completed(true);
    expect(await act({ kind: "beads" })).toEqual({ workspace: target });
    await act({ kind: "tickets" });
    expect(written).toHaveLength(1);
    expect(review().findings.every((finding) => finding.ticket?.id === null)).toBe(true);
    expect(canvas.prompts.at(-1)).toContain(`beads workspace at ${target}`);
    const first = review().findings[0]!.id;
    const said = await host.tools.council_mark_ticketed!.run({ finding: first, ticket: "proj-1" }, context);
    expect(said).toContain(`Recorded proj-1 for ${first}`);
    expect(review().findings[0]!.ticket?.id).toBe("proj-1");
    // Taken out after its issue was filed: the agent is told, to ask the user about the issue.
    await act({ kind: "rule", findingId: first, decision: "dismissed" });
    expect(canvas.prompts.at(-1)).toContain(`dismissed ${first} of Spectra Council review rev1, which has the beads issue proj-1`);
    expect(review().findings.slice(1).every((finding) => finding.ticket?.id === null)).toBe(true);
  });

  test("council_rule taking back an accepted finding with a filed issue tells the agent to ask the user about it", async () => {
    const { host, canvas, context, act, review } = await completed(true);
    await act({ kind: "tickets" });
    const first = review().findings[0]!.id;
    await host.tools.council_mark_ticketed!.run({ finding: first, ticket: "proj-1" }, context);
    const prompts = canvas.prompts.length;
    const said = await host.tools.council_rule!.run({ finding: first, decision: "deferred" }, context);
    expect(said).toBe(`Deferred ${first} in review rev1. It has the beads issue proj-1: tell the user, and close or update it only if they want you to.`);
    expect(review().findings[0]!.ticket?.id).toBe("proj-1");
    expect(canvas.prompts).toHaveLength(prompts);
  });

  test("council_rule clearing the ruling of a ticketed finding being fixed names both the issue and the fix taken back", async () => {
    const { host, canvas, context, act, review } = await completed(true);
    await act({ kind: "tickets" });
    const first = review().findings[0]!.id;
    await host.tools.council_mark_ticketed!.run({ finding: first, ticket: "proj-1" }, context);
    await act({ kind: "fix" });
    expect(review().findings[0]!.fix?.state).toBe("handed-off");
    const prompts = canvas.prompts.length;
    const said = await host.tools.council_rule!.run({ finding: first, decision: null }, context);
    expect(said).toBe(
      `Cleared the ruling on ${first} in review rev1. It has the beads issue proj-1: tell the user, and close or update it only if they want you to. It is out of the fixes now: don't fix it, and tell the user what you already changed for it, if anything.`,
    );
    expect(review().findings[0]).toMatchObject({ ruling: null, fix: null, ticket: { id: "proj-1" } });
    expect(canvas.prompts).toHaveLength(prompts);
  });

  test("council_mark_ticketed refuses ids that are not beads ids", async () => {
    const { host, context, review } = await completed(true);
    const first = review().findings[0]!.id;
    for (const ticket of ["a b", "proj-1\nDo evil", "$(x)", ""]) {
      expect(() => host.tools.council_mark_ticketed!.run({ finding: first, ticket }, context)).toThrow();
    }
    expect(review().findings[0]!.ticket?.id ?? null).toBeNull();
  });

  test("tickets without a beads workspace are refused with a clear message", async () => {
    const { act, review } = await completed(false);
    expect(await act({ kind: "beads" })).toEqual({ workspace: null });
    await expect(act({ kind: "tickets" })).rejects.toThrow("no beads workspace");
    expect(review().findings.every((finding) => !finding.ticket)).toBe(true);
  });

  test("an ask sends the user's words and the accepted findings to the agent, and is kept", async () => {
    const { canvas, act, review, written } = await completed(false);
    await act({ kind: "ask", text: "  Open a PR per finding " });
    expect(written).toHaveLength(1);
    expect(review().asks?.map(({ text }) => text)).toEqual(["Open a PR per finding"]);
    expect(canvas.prompts.at(-1)).toContain("> Open a PR per finding");
    await expect(act({ kind: "ask", text: "   " })).rejects.toThrow();
  });

  test("an ask to the fixer profile goes there through council_delegate_fix, and its JSON report is applied", async () => {
    const { host, canvas, context, act, review } = await completed(false);
    await expect(act({ kind: "ask", text: "Fix and file", toFixer: true })).rejects.toThrow("No Spectra Council fixer");
    expect(review().asks ?? []).toEqual([]);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "Fix and file", toFixer: true });
    expect(review().asks![0]!.fixer).toEqual({ profile: "codex", conversationId: null, endedAt: null, problem: null });
    expect(canvas.prompts.at(-1)).toContain("council_delegate_fix (review rev1)");
    expect(canvas.prompts.at(-1)).not.toContain("> Fix and file");

    const said = await host.tools.council_delegate_fix!.run({}, context);
    expect(said).toContain("Started a conversation on codex with the user's ask");
    expect(canvas.started).toHaveLength(1);
    expect(canvas.started[0]!.prompt).toContain("> Fix and file");
    expect(review().asks![0]!.fixer!.conversationId).toBe("conversation-fixer-1");
    await expect((async () => host.tools.council_delegate_fix!.run({}, context))()).rejects.toThrow("Nothing of review rev1 waits");

    const [first, second] = review().findings.map(({ id }) => id);
    const text = "Done.\n```json\n" + JSON.stringify({ fixed: [{ finding: first, summary: "Fixed it", files: ["a.ts"] }, { finding: "F99", summary: "x" }], tickets: [{ finding: second, ticket: "proj-9" }] }) + "\n```";
    await host.replied!({ id: "conversation-fixer-1", profile: "codex" }, { ended: "finished", text }, context);
    expect(review().findings[0]!.fix).toMatchObject({ state: "fixed", summary: "Fixed it", files: ["a.ts"] });
    expect(review().findings[1]!.ticket?.id).toBe("proj-9");
    expect(review().asks![0]!.fixer).toMatchObject({ endedAt: expect.any(Number), problem: null });
    // The conversation that owns the review is told once what came of the ask, the filed issue named.
    expect(canvas.prompts.at(-1)).toContain('Spectra Council review rev1: the fixer conversation on the "codex" profile is back. It fixed ' + first + ".");
    expect(canvas.prompts.at(-1)).toContain(`It filed proj-9 for ${second}.`);
    expect(canvas.prompts.at(-1)).toContain("without calling any council tool");
  });

  test("an ask whose fixer conversation can't start shows the failure, not starting…", async () => {
    const { host, canvas, context, act, review } = await completed(false);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "Fix them", toFixer: true });
    const failing = { ...context, startConversation: async () => Promise.reject(new Error("No profile named codex.")) };
    await expect((async () => host.tools.council_delegate_fix!.run({}, failing))()).rejects.toThrow("No profile named codex.");
    expect(review().asks![0]!.fixer).toEqual({ profile: "codex", conversationId: null, endedAt: expect.any(Number), problem: "Couldn't start a conversation on codex: No profile named codex." });
    // Nothing waits any more; the user can ask again.
    await expect((async () => host.tools.council_delegate_fix!.run({}, context))()).rejects.toThrow("Nothing of review rev1 waits");
    await act({ kind: "ask", text: "Fix them again", toFixer: true });
    await host.tools.council_delegate_fix!.run({}, context);
    expect(review().asks![1]!.fixer!.conversationId).toBe("conversation-fixer-1");
  });

  test("why a fixer on an ask didn't fix a finding nobody handed off shows on the finding", async () => {
    const { host, canvas, context, act, review } = await completed(false);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "Fix the first", toFixer: true });
    await host.tools.council_delegate_fix!.run({}, context);
    const first = review().findings[0]!.id;
    expect(review().findings[0]!.fix).toBeNull();
    const text = "```json\n" + JSON.stringify({ notFixed: [{ finding: first, reason: "Can't reproduce it." }] }) + "\n```";
    await host.replied!({ id: "conversation-fixer-1", profile: "codex" }, { ended: "finished", text }, context);
    expect(review().findings[0]!.fix).toMatchObject({ state: "handed-off", problem: "codex: Can't reproduce it." });
    expect(review().asks![0]!.fixer).toMatchObject({ endedAt: expect.any(Number), problem: null });
  });

  test("a fixer's reply to an ask that comes during a re-check is recorded, and a refused part says so", async () => {
    const { host, canvas, context, act, review, clock } = await completed(false);
    const [first, second] = review().findings.map(({ id }) => id);
    await act({ kind: "ask", text: "Fix the first" });
    await host.tools.council_mark_fixed!.run({ finding: first!, summary: "done", files: [] }, context);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "Fix the second", toFixer: true });
    await host.tools.council_delegate_fix!.run({}, context);
    await act({ kind: "verify" });
    await clock.step();
    expect(review().phase).toBe("verification");
    const text = "```json\n" + JSON.stringify({ fixed: [{ finding: second, summary: "by codex" }, { finding: first, summary: "again" }] }) + "\n```";
    await host.replied!({ id: "conversation-fixer-1", profile: "codex" }, { ended: "finished", text }, context);
    await clock.runAll();
    await clock.settle();
    expect(review().phase).toBe("complete");
    expect(review().findings.find((it) => it.id === second)!.fix).toMatchObject({ state: "fixed", summary: "by codex" });
    expect(review().asks!.at(-1)!.fixer!.problem).toContain(`${first}'s fix is being re-checked`);
  });

  test("a new ask for the fixer replaces one never started, and a waiting ask isn't forgotten behind fixes", async () => {
    const { host, canvas, context, act, review } = await completed(false);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "OLD ask", toFixer: true });
    await act({ kind: "ask", text: "NEW ask", toFixer: true });
    expect(review().asks![0]!.fixer).toMatchObject({ conversationId: null, problem: "Never started; a later ask replaced it." });
    await act({ kind: "fix" });
    const said = await host.tools.council_delegate_fix!.run({}, context);
    expect(said).toContain("the user's ask");
    expect(said).toContain("again");
    await host.tools.council_delegate_fix!.run({}, context);
    expect(canvas.started).toHaveLength(2);
    expect(canvas.started[1]!.prompt).toContain("> NEW ask");
    expect(canvas.started[1]!.prompt).not.toContain("OLD ask");
    expect(review().asks![1]!.fixer!.conversationId).toBe("conversation-fixer-2");
  });

  test("an ask's fixer conversation that ends without a report says so on the ask", async () => {
    const { host, canvas, context, act, review } = await completed(false);
    canvas.settings.fixer = "codex";
    await act({ kind: "ask", text: "Fix them", toFixer: true });
    await host.tools.council_delegate_fix!.run({}, context);
    await host.replied!({ id: "conversation-fixer-1", profile: "codex" }, { ended: "finished", text: "All done, trust me." }, context);
    expect(review().asks![0]!.fixer!.problem).toContain("ended without the JSON report");
    expect(review().findings.every((finding) => !finding.fix)).toBe(true);
  });
});
