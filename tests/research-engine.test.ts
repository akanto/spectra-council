import { describe, expect, test } from "bun:test";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { assignSourceChecks, citedClaimIds, defaultAnswerFile, draftProblems, settleClaim } from "../core/research.ts";
import { newReview, reduce } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";
import { FakeClock } from "./support.ts";

const source = (n: number) => ({ url: `https://doi.org/10.1/${n}`, doi: `10.1/${n}`, authors: "A. Author", title: `Paper ${n}`, venue: "Proc. X", year: 2024, quote: `quote ${n}`, read: "full-text" as const });

const fact = (title: string, n: number): ClaimInput => ({ rq: "RQ1", kind: "fact", title, text: `${title}.`, confidence: "high", fields: { "DICOM level": "series" }, sources: [source(n)] });

const research = (seats = 2, extra: Partial<Parameters<typeof newReview>[1]> = {}) =>
  newReview(
    "rev1",
    {
      kind: "research",
      target: "/repo",
      brief: "/repo/journal/brief.md",
      profile: "general",
      depth: "quick",
      instructions: "",
      seats: ["mock-claude", "mock-codex", "mock-gemini"].slice(0, seats).map((agent) => ({ agent, enabled: true })),
      ...extra,
    },
    "mock",
    0,
  );

/**
 * A scripted research runner: r1 reports C-claims about papers 1 and 2, r2 the same paper 1 (merged by the grouping
 * turn when it is asked) and paper 3; checkers verify papers 1 and 2 and find paper 3's quote missing; in the round, r2
 * challenges paper 2's claim; the editor cites what stands; checkers object once to the first draft.
 */
function scripted(options: { objections?: boolean } = {}): ReviewerRunner & { drafts: number } {
  const runner = {
    drafts: 0,
    async run() {
      throw new Error("not a review");
    },
    async research(job: Parameters<NonNullable<ReviewerRunner["research"]>>[0], report: Parameters<NonNullable<ReviewerRunner["research"]>>[1]) {
      const pass = job.review.research!.pass;
      if (pass > 0) {
        if (job.reviewer.id === "r1") report({ type: "claim-reported", claim: fact("Follow-up finding", 9) });
        return;
      }
      if (job.reviewer.id === "r1") {
        report({ type: "claim-reported", claim: fact("IDC cohorts filter on series attributes", 1) });
        report({ type: "claim-reported", claim: fact("Training reads whole series", 2) });
      } else {
        report({ type: "claim-reported", claim: fact("IDC cohorts filter series attributes", 1) });
        report({ type: "claim-reported", claim: fact("Lesion-only slice reads are published", 3) });
        report({ type: "claim-reported", claim: { rq: "RQ2", kind: "gap", title: "No PACS log study found", text: "Searched JDI 2015-2025.", confidence: "medium", fields: {}, sources: [] } });
      }
    },
    async deliberate(job: Parameters<ReviewerRunner["deliberate"]>[0], report: Parameters<ReviewerRunner["deliberate"]>[1]) {
      for (const claim of job.review.research!.claims.filter((each) => each.pass === job.review.research!.pass)) {
        const mine = claim.reviewerId === job.reviewer.id || claim.alsoReported.some((each) => each.reviewerId === job.reviewer.id);
        if (mine) continue;
        const challenge = claim.title === "Training reads whole series";
        report({ type: "argued", argument: { findingId: claim.id, stance: challenge ? "challenges" : "supports", confidence: "high", text: challenge ? "The paper reads patches, not series." : "Checked; it holds." } });
      }
    },
    async propose() {},
    async verify() {},
    async checkSources(job: Parameters<NonNullable<ReviewerRunner["checkSources"]>>[0], report: Parameters<NonNullable<ReviewerRunner["checkSources"]>>[1]) {
      for (const id of job.claimIds) {
        const claim = job.review.research!.claims.find((each) => each.id === id)!;
        claim.sources.forEach((each, index) => report({ type: "source-checked", check: { claimId: id, source: index + 1, outcome: each.doi === "10.1/3" ? "quote-not-found" : "verified", note: "Opened it." } }));
      }
    },
    async draft(job: Parameters<NonNullable<ReviewerRunner["draft"]>>[0], report: Parameters<NonNullable<ReviewerRunner["draft"]>>[1]) {
      runner.drafts++;
      const standing = job.review.research!.claims.filter((claim) => ["agreed", "confirmed", "disputed"].includes(claim.status) && claim.ruling?.decision !== "struck");
      report({ type: "answer-drafted", markdown: `# Answer (revision ${job.revision})\n\n${standing.map((claim) => `- ${claim.title} [${claim.id}]`).join("\n")}` });
    },
    async checkDraft(job: Parameters<NonNullable<ReviewerRunner["checkDraft"]>>[0], report: Parameters<NonNullable<ReviewerRunner["checkDraft"]>>[1]) {
      if (options.objections && job.draft.revision === 0) report({ type: "draft-objected", objection: { excerpt: job.draft.markdown.split("\n")[2] ?? "", problem: "Overstated." } });
    },
  };
  return runner as unknown as ReviewerRunner & { drafts: number };
}

/** A grouping turn as an agent would take it: the two claims on paper 1 are one. */
const withGrouping = (runner: ReviewerRunner): ReviewerRunner => ({
  ...runner,
  research: runner.research!.bind(runner),
  deliberate: runner.deliberate.bind(runner),
  checkSources: runner.checkSources!.bind(runner),
  draft: runner.draft!.bind(runner),
  checkDraft: runner.checkDraft!.bind(runner),
  async group(job, report) {
    const ids = job.review.research!.claims.filter((claim) => claim.sources.some((each) => each.doi === "10.1/1")).map(({ id }) => id);
    report({ type: "duplicates-grouped", group: { claimIds: ids, reason: "Same paper, same point." } });
  },
});

async function play(review: Review, runner: ReviewerRunner, work: (session: ReviewSession) => Promise<Review> = (session) => session.run()) {
  const clock = new FakeClock();
  const written: Review[] = [];
  const session = new ReviewSession(review, {
    runner,
    clock,
    onChange: () => {},
    writeAnswer: async (at) => {
      written.push(at);
      return { path: "/repo/journal/brief-answer.md", digest: `d${written.length}` };
    },
  });
  const done = work(session);
  await clock.runAll();
  return { review: await done, written };
}

describe("research council", () => {
  test("researches, merges, checks sources, argues, settles and writes one answer", async () => {
    // The grouping turn is a real agent's: profile seats.
    const seats = ["profile:A", "profile:B"].map((agent) => ({ agent, enabled: true }));
    const { review, written } = await play(research(2, { seats }), withGrouping(scripted()));
    const claims = review.research!.claims;
    expect(review.phase).toBe("complete");
    expect(review.rounds).toBe(1);
    // The two reports of paper 1 merged into the first.
    expect(claims.map((claim) => claim.id)).toEqual(["C1", "C2", "C4", "C5"]);
    expect(claims[0]!.alsoReported.map((report) => report.reviewerId)).toEqual(["r2"]);
    const status = Object.fromEntries(claims.map((claim) => [claim.title, claim.status]));
    expect(status).toEqual({
      "IDC cohorts filter on series attributes": "agreed",
      "Training reads whole series": "disputed",
      "Lesion-only slice reads are published": "unverified",
      "No PACS log study found": "agreed",
    });
    // Paper 2's source was verified, so the standing challenge leaves its claim disputed, not unverified.
    expect(claims[1]!.sources[0]!.checks.map((check) => check.outcome)).toEqual(["verified"]);
    expect(review.research!.drafts).toHaveLength(1);
    expect(review.research!.written).toMatchObject({ path: "/repo/journal/brief-answer.md" });
    expect(written).toHaveLength(1);
    expect(review.verdict?.summary).toContain("4 claims");
  });

  test("an objection to the draft gets one revision", async () => {
    const runner = scripted({ objections: true });
    const { review } = await play(research(), runner);
    expect(review.research!.objections).toHaveLength(1);
    expect(review.research!.drafts.map((draft) => draft.revision)).toEqual([0, 1]);
  });

  test("with one seat, nothing is deliberated and the editor still answers", async () => {
    const { review } = await play(research(1), scripted());
    expect(review.rounds).toBe(0);
    expect(review.research!.claims.every((claim) => claim.status === "reported")).toBe(true);
    expect(review.research!.drafts).toHaveLength(1);
    expect(review.phase).toBe("complete");
  });

  test("a follow-up adds a run, and a strike makes the editor revise", async () => {
    const runner = scripted();
    let { review } = await play(research(), runner);
    review = reduce(review, { type: "follow-up-asked", at: 5, question: "Look at RSNA." });
    ({ review } = await play(review, runner, (session) => session.followUp()));
    expect(review.research!.pass).toBe(1);
    expect(review.research!.claims.filter((claim) => claim.pass === 1).map((claim) => claim.title)).toEqual(["Follow-up finding"]);
    expect(review.research!.drafts.at(-1)).toMatchObject({ pass: 1, revision: 0 });
    expect(review.phase).toBe("complete");

    const first = review.research!.claims.find((claim) => claim.status === "confirmed" || claim.status === "agreed")!;
    review = reduce(review, { type: "claim-ruled", at: 6, claimId: first.id, decision: "struck", note: "" });
    expect(review.research!.revisionDue).toBe(true);
    ({ review } = await play(review, runner, (session) => session.revise()));
    expect(review.phase).toBe("complete");
    expect(review.research!.revisionDue).toBe(false);
    expect(review.research!.drafts.at(-1)!.markdown).not.toContain(`[${first.id}]`);
  });
});

describe("research rules", () => {
  test("cited ids, draft problems and the default answer file", () => {
    expect(citedClaimIds("A [C1]. B [C3, C2]; again [C1].")).toEqual(["C1", "C3", "C2"]);
    expect(defaultAnswerFile("/p/journal/workload-research-brief.md")).toBe("/p/journal/workload-research-brief-answer.md");
    const review = research();
    expect(draftProblems(review, "Says [C9].")).toEqual(["It cites C9, which no claim has."]);
  });

  test("source checks avoid the reporter and spread the load", () => {
    let review = reduce(research(3), { type: "started", at: 1 });
    for (const reviewerId of ["r1", "r2", "r3"]) {
      review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
      review = reduce(review, { type: "claim-reported", reviewerId, at: 3, claim: fact(`claim of ${reviewerId}`, 1) });
      review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
    }
    review = reduce(review, { type: "deliberation-started", at: 5, rounds: 1 });
    const assigned = assignSourceChecks(review);
    const pairs = [...assigned].flatMap(([checker, ids]) => ids.map((id) => [id, checker]));
    for (const [id, checker] of pairs) expect(review.research!.claims.find((claim) => claim.id === id)!.reviewerId).not.toBe(checker);
    expect(pairs).toHaveLength(3);
    expect([...assigned.values()].every((ids) => ids.length === 1)).toBe(true);
    expect(settleClaim({ ...review, rounds: 0 }, review.research!.claims[0]!)).toBeNull();
  });
});
