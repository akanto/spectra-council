/**
 * Regression tests for the independent review of research councils: a failed editor, revisions that fail or come from
 * the user's rulings, resume of the synthesis, stopping a follow-up, failed seats in a follow-up, the editor following
 * the seats, unsettled citations, and source checks held to their assignment.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftPrompt } from "../core/agent-turns.ts";
import { ReviewSession, type DraftJob, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { draftProblems } from "../core/research.ts";
import { newReview, reduce } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const source = (n: number) => ({ url: `https://example.org/${n}`, authors: "A. Author", title: `Paper ${n}`, venue: "Venue", quote: `quote ${n}`, read: "full-text" as const });
const fact = (title: string, n: number): ClaimInput => ({ rq: "RQ1", kind: "fact", title, text: `${title}.`, confidence: "high", fields: {}, sources: [source(n)] });

const research = (seats = 2) =>
  newReview(
    "rev1",
    { kind: "research", target: "/repo", brief: "/repo/brief.md", profile: "general", depth: "quick", instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini"].slice(0, seats).map((agent) => ({ agent, enabled: true })) },
    "mock",
    0,
  );

interface Options {
  /** Seats whose draft turns fail. */
  failDraft?: Set<string>;
  /** Seats whose research fails. */
  failResearch?: Set<string>;
  /** Called with each draft job. */
  onDraft?: (job: DraftJob) => void;
  /** Hold the draft turns until released. */
  hold?: Promise<void>;
}

function runner(options: Options = {}): ReviewerRunner {
  return {
    run: async () => {
      throw new Error("not a review");
    },
    propose: async () => {},
    verify: async () => {},
    research: async (job, report) => {
      if (options.failResearch?.has(job.reviewer.id)) throw new Error("no network");
      report({ type: "claim-reported", claim: fact(`Claim of ${job.reviewer.id} in run ${job.review.research!.pass}`, Number(job.reviewer.id.slice(1))) });
    },
    deliberate: async (job, report) => {
      for (const claim of job.review.research!.claims.filter((each) => each.pass === job.review.research!.pass && each.reviewerId !== job.reviewer.id)) {
        report({ type: "argued", argument: { findingId: claim.id, stance: "supports", confidence: "high", text: "Holds." } });
      }
    },
    checkSources: async (job, report) => {
      for (const claimId of job.claimIds) report({ type: "source-checked", check: { claimId, source: 1, outcome: "verified", note: "Opened it." } });
    },
    draft: async (job, report) => {
      options.onDraft?.(job);
      if (options.hold) await options.hold;
      if (options.failDraft?.has(job.reviewer.id)) throw new Error("timed out");
      const ids = job.review.research!.claims.filter((claim) => ["agreed", "confirmed", "reported"].includes(claim.status) && claim.ruling?.decision !== "struck").map(({ id }) => `[${id}]`);
      report({ type: "answer-drafted", markdown: `Answer by ${job.reviewer.id} ${ids.join(" ")}` });
    },
    checkDraft: async () => {},
  };
}

async function play(review: Review, run: ReviewerRunner, work: (session: ReviewSession) => Promise<Review> = (session) => session.run()) {
  const clock = new FakeClock();
  const session = new ReviewSession(review, { runner: run, clock, onChange: () => {}, writeAnswer: async () => ({ path: "/repo/brief-answer.md", digest: "d" }) });
  const done = work(session);
  await clock.runAll();
  return { review: await done, session };
}

describe("the editor and revisions", () => {
  test("when the editor's draft fails, the next seat sitting writes the answer", async () => {
    const { review } = await play(research(), runner({ failDraft: new Set(["r1"]) }));
    expect(review.research!.drafts.map((draft) => draft.editorId)).toEqual(["r2"]);
    expect(review.research!.written).not.toBeNull();
  });

  test("when every draft fails, a revision is due, and asking for it writes the answer", async () => {
    let { review } = await play(research(), runner({ failDraft: new Set(["r1", "r2"]) }));
    expect(review.research!.drafts).toHaveLength(0);
    expect(review.research!.revisionDue).toBe(true);
    ({ review } = await play(review, runner(), (session) => session.revise()));
    expect(review.research!.drafts).toHaveLength(1);
    expect(review.research!.revisionDue).toBe(false);
  });

  test("a revision after a strike tells the editor what changed and what the old draft gets wrong", async () => {
    let { review } = await play(research(), runner());
    review = reduce(review, { type: "claim-ruled", at: review.endedAt! + 1, claimId: "C1", decision: "struck", note: "Wrong paper." });
    let job: DraftJob | null = null;
    ({ review } = await play(review, runner({ onDraft: (each) => (job = each) }), (session) => session.revise()));
    expect(job!.problems).toEqual(["It cites C1, which the user struck."]);
    const prompt = draftPrompt(job!);
    expect(prompt).toContain("C1 struck (Wrong paper.)");
    expect(review.research!.drafts.at(-1)!.markdown).not.toContain("[C1]");
  });

  test("a revision that fails leaves it due, so it can be asked for again", async () => {
    let { review } = await play(research(), runner());
    review = reduce(review, { type: "claim-ruled", at: review.endedAt! + 1, claimId: "C1", decision: "struck", note: "" });
    ({ review } = await play(review, runner({ failDraft: new Set(["r1", "r2"]) }), (session) => session.revise()));
    expect(review.phase).toBe("complete");
    expect(review.research!.revisionDue).toBe(true);
  });

  test("resuming an interrupted answer keeps the drafts so far and drafts a further revision", async () => {
    let { review } = await play(research(), runner());
    review = reduce(review, { type: "claim-ruled", at: review.endedAt! + 1, claimId: "C1", decision: "struck", note: "" });
    review = reduce(review, { type: "revision-started", at: review.endedAt! + 2 });
    review = reduce(review, { type: "interrupted", at: review.endedAt! + 3 });
    expect(reduce(review, { type: "resumed", at: review.endedAt! + 4 }).research!.drafts).toHaveLength(1);
    ({ review } = await play(review, runner(), (session) => session.resume()));
    expect(review.research!.drafts.map((draft) => draft.revision)).toEqual([0, 1]);
  });
});

describe("follow-ups", () => {
  test("stopping a follow-up leaves the council answered, and it can be sent back again", async () => {
    let { review } = await play(research(), runner());
    review = reduce(review, { type: "follow-up-asked", at: 10, question: "More?" });
    review = reduce(review, { type: "follow-up-started", at: 11 });
    review = reduce(review, { type: "stopped", at: 12 });
    expect(review.phase).toBe("complete");
    expect(review.verdict).not.toBeNull();
    expect(review.reviewers.every((reviewer) => reviewer.status === "completed")).toBe(true);
    review = reduce(review, { type: "follow-up-asked", at: 13, question: "Again?" });
    ({ review } = await play(review, runner(), (session) => session.followUp()));
    expect(review.research!.pass).toBe(2);
    expect(review.phase).toBe("complete");
  });

  test("a seat that failed before researches the next follow-up", async () => {
    let { review } = await play(research(3), runner({ failResearch: new Set(["r3"]) }));
    expect(review.reviewers[2]!.status).toBe("failed");
    review = reduce(review, { type: "follow-up-asked", at: 10, question: "More?" });
    ({ review } = await play(review, runner(), (session) => session.followUp()));
    expect(review.research!.claims.some((claim) => claim.reviewerId === "r3" && claim.pass === 1)).toBe(true);
  });
});

describe("the ledger's rules", () => {
  test("the editor follows the seats when its seat goes", () => {
    let review = reduce(research(3), { type: "configured", patch: { editor: "r3" } });
    review = reduce(review, { type: "configured", patch: { seats: review.reviewers.slice(0, 2).map((reviewer) => ({ agent: reviewer.agent, enabled: true })) } });
    expect(review.research!.editor).toBe("r1");
  });

  test("a deliberated run's unsettled claim can't be cited", () => {
    let review = reduce(research(), { type: "started", at: 1 });
    for (const reviewerId of ["r1", "r2"]) {
      review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
      review = reduce(review, { type: "claim-reported", reviewerId, at: 3, claim: fact(`claim of ${reviewerId}`, 1) });
      review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
    }
    review = reduce(review, { type: "deliberation-started", at: 5, rounds: 1 });
    review = reduce(review, { type: "synthesis-started", at: 6 });
    expect(draftProblems(review, "See [C1].")).toEqual(["It cites C1, which the council left unsettled: nobody backs it."]);
  });

  test("a seat can't check a source it wasn't given", async () => {
    const run = runner();
    const checked: string[] = [];
    const sneaky: ReviewerRunner = {
      ...run,
      checkSources: async (job, report) => {
        // Every claim of the run, its own included.
        for (const claim of job.review.research!.claims) report({ type: "source-checked", check: { claimId: claim.id, source: 1, outcome: "verified", note: "Mine." } });
        checked.push(...job.claimIds);
      },
    };
    const { review } = await play(research(), sneaky);
    for (const claim of review.research!.claims) for (const check of claim.sources[0]!.checks) expect(check.reviewerId).not.toBe(claim.reviewerId);
    expect(checked.sort()).toEqual(["C1", "C2"]);
  });
});

const workspace = await mkdtemp(join(tmpdir(), "spectra-fixes-"));
const brief = join(workspace, "brief.md");
await writeFile(brief, "# Brief\n");

describe("the host's research work", () => {
  const setup = () => {
    const clock = new FakeClock();
    const make = () => createCouncilHost({ clock, listFiles: async () => FILES, newId: () => "rev1", throttleMs: 0, writeFile: async () => {}, runnerFor: (agent) => (agent.startsWith("profile:") ? runner() : undefined) });
    const canvas = new FakeCanvas<Review>();
    return { clock, make, host: make(), canvas, context: canvas.context() };
  };

  test("council_begin starts no revision the user didn't ask for, and Revise starts the revision, not a waiting follow-up", async () => {
    const { clock, make, host, canvas, context } = setup();
    await host.tools.council_open!.run({ target: workspace, brief, agents: ["profile:a", "profile:b"] }, context);
    const id = canvas.items[0]!.id;
    await host.action!(canvas.item(id), { kind: "start" }, context);
    await clock.runAll();
    await clock.settle();
    await host.action!(canvas.item(id), { kind: "rule-claim", claimId: "C1", decision: "struck", note: "" }, context);
    const restarted = make();
    await expect(restarted.tools.council_begin!.run({}, context)).rejects.toThrow("hasn't asked");
    // A follow-up whose start never happened waits (a host with no tool context only asks the agent); Revise starts the
    // revision all the same.
    expect(await make().action!(canvas.item(id), { kind: "follow-up", text: "More?" }, context)).toEqual({ prompted: true });
    const again = make();
    expect(await again.action!(canvas.item(id), { kind: "revise" }, context)).toEqual({ prompted: true });
    expect(String(await again.tools.council_begin!.run({}, context))).toContain("revision");
    await clock.runAll();
    await clock.settle();
    const review = canvas.item(id).data;
    expect(review.research!.pass).toBe(0);
    expect(review.research!.revisionDue).toBe(false);
    expect(review.research!.followUps.at(-1)!.startedAt).toBeNull();
  });

  test("council_open refuses an editor that isn't a seat", async () => {
    const { host, context } = setup();
    await expect(host.tools.council_open!.run({ target: workspace, brief, agents: ["profile:a", "profile:b"], editor: "r3" }, context)).rejects.toThrow("isn't a seat");
  });
});
