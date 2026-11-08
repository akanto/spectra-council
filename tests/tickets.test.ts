import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../core/model.ts";
import { newReview, reduce, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { askPrompt, BEADS_PRIORITY, ticketsPrompt, unticketed, waitingTickets } from "../core/tickets.ts";
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
    expect(prompt).toContain("From Spectra Council review rev1, finding <id>");
    expect(prompt).toContain('council_mark_ticketed with review "rev1"');
    expect(prompt).toContain('bd search --desc-contains "review rev1, finding <id>"');
    expect(prompt).toContain("Don't fix them now");
    expect(BEADS_PRIORITY.info).toBe(4);
  });

  test("ask: the user's words quoted, with the accepted findings and the hand-off", () => {
    const prompt = askPrompt(concluded(), "Fix only the security ones\nand add tests", "/repo/h.md");
    expect(prompt).toContain("> Fix only the security ones\n> and add tests");
    expect(prompt).toContain("- F2 (critical");
    expect(prompt).not.toContain("F3");
    expect(prompt).toContain("/repo/h.md");
    expect(prompt).toContain('council_mark_fixed with review "rev1"');
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
    return { target, host, canvas, context, act, review, written };
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
});
