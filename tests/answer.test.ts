import { describe, expect, test } from "bun:test";
import { answerDigest, answerMarkdown, claimStatusText } from "../core/answer.ts";
import { describeReview, finishedPrompt } from "../core/describe.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";

const source = (n: number) => ({ url: `https://doi.org/10.1/${n}`, doi: `10.1/${n}`, authors: "A. Author", title: `Paper ${n}`, venue: "Proc. X", year: 2024, quote: `quote ${n}`, locator: "p. 4", read: "full-text" as const });
const fact = (title: string, n: number, rq = "RQ1"): ClaimInput => ({ rq, kind: "fact", title, text: `${title}.`, confidence: "high", fields: { "DICOM level": "series" }, sources: [source(n)] });

function base(): Review {
  let review = newReview("rev1", { kind: "research", target: "/repo", brief: "/repo/journal/brief.md", profile: "general", depth: "quick", instructions: "", seats: ["mock-claude", "mock-codex"].map((agent) => ({ agent, enabled: true })) }, "mock", 0);
  review = reduce(review, { type: "started", at: 1 });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 2 });
  review = reduce(review, { type: "claim-reported", reviewerId: "r1", at: 3, claim: fact("Cohorts filter on series", 1) });
  review = reduce(review, { type: "claim-reported", reviewerId: "r1", at: 3, claim: fact("Reads whole series", 2, "RQ2") });
  review = reduce(review, { type: "claim-reported", reviewerId: "r2", at: 3, claim: { rq: "", kind: "gap", title: "No PACS study", text: "Searched.", confidence: "medium", fields: {}, sources: [] } });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 4, outcome: "completed" });
  review = reduce(review, { type: "deliberation-started", at: 5, rounds: 1 });
  review = reduce(review, { type: "source-checked", reviewerId: "r2", at: 6, check: { claimId: "C1", source: 1, outcome: "verified", note: "Opened it." } });
  review = reduce(review, { type: "sources-checked", at: 6 });
  review = reduce(review, { type: "synthesis-started", at: 7 });
  review = reduce(review, { type: "claim-resolved", at: 7, claimId: "C1", status: "agreed", rationale: "All back it.", dissenters: [] });
  review = reduce(review, { type: "claim-resolved", at: 7, claimId: "C2", status: "unverified", rationale: "Nobody checked.", dissenters: [] });
  review = reduce(review, { type: "claim-resolved", at: 7, claimId: "C3", status: "agreed", rationale: "Fine.", dissenters: [] });
  return review;
}

const finish = (review: Review) => reduce(review, { type: "concluded", at: 30, summary: "3 claims." });

const draft = (review: Review, markdown: string, problems: string[] = []) => reduce(review, { type: "answer-drafted", reviewerId: "r1", at: 10, markdown, problems });

describe("answerMarkdown", () => {
  test("lists every claim with status, sources and their checks, grouped by question", () => {
    const text = answerMarkdown(finish(draft(base(), "# Answer\n\nIt filters on series [C1].")));
    expect(text).toContain("# Answer to brief");
    expect(text).toContain("research council rev1");
    expect(text).toContain("It filters on series [C1].");
    expect(text).toContain("## Ledger");
    for (const id of ["C1", "C2", "C3"]) expect(text).toContain(`#### ${id} `);
    expect(text).toContain("agreed");
    expect(text).toContain("unverified");
    expect(text).toContain("Check by R2: verified. Opened it.");
    expect(text).toContain("Checks: none.");
    expect(text).toContain('quote 1');
    expect(text).toContain("DICOM level: series");
    expect(text.indexOf("### RQ1")).toBeLessThan(text.indexOf("### RQ2"));
    expect(text.indexOf("### RQ2")).toBeLessThan(text.indexOf("### Other"));
  });

  test("a struck claim is marked with its note", () => {
    const review = reduce(finish(draft(base(), "x [C1]")), { type: "claim-ruled", at: 11, claimId: "C1", decision: "struck", note: "wrong cohort" });
    const text = answerMarkdown(review);
    expect(text).toContain("struck by the user");
    expect(text).toContain("wrong cohort");
    expect(claimStatusText(review.research!.claims[0]!)).toBe("struck by the user");
  });

  test("the objections block appears only when a revision followed objections", () => {
    let review = draft(base(), "First [C1].");
    review = reduce(review, { type: "draft-objected", reviewerId: "r2", at: 11, objection: { claimId: "C1", excerpt: "First [C1].", problem: "Overstated." } });
    expect(answerMarkdown(finish(review))).not.toContain("Council objections");
    review = finish(draft(review, "Second [C1]."));
    const text = answerMarkdown(review);
    expect(text).toContain("## Council objections to the first draft");
    expect(text).toContain("Overstated.");
    expect(text).toContain("Second [C1].");
    expect(text).not.toContain("First [C1].\"\n\nFirst");
  });

  test("a draft's problems show as a warning", () => {
    const text = answerMarkdown(finish(draft(base(), "Says [C9].", ["It cites C9, which no claim has."])));
    expect(text).toContain("Warning");
    expect(text).toContain("It cites C9, which no claim has.");
    expect(answerMarkdown(finish(draft(base(), "Fine [C1].")))).not.toContain("Warning");
  });

  test("without a draft, the ledger stands alone", () => {
    const text = answerMarkdown(finish(base()));
    expect(text).toContain("No answer was drafted");
    expect(text).toContain("## Ledger");
  });

  test("a follow-up's claims are marked", () => {
    let review = finish(draft(base(), "A [C1]."));
    review = reduce(review, { type: "follow-up-asked", at: 12, question: "Look at RSNA." });
    review = reduce(review, { type: "follow-up-started", at: 13 });
    review = reduce(review, { type: "claim-reported", reviewerId: "r1", at: 14, claim: fact("RSNA finding", 7) });
    const text = answerMarkdown(review);
    expect(text).toContain("follow-up 1: Look at RSNA.");
  });

  test("the same review gives the same text and digest", () => {
    const review = finish(draft(base(), "A [C1]."));
    expect(answerMarkdown(review)).toBe(answerMarkdown(structuredClone(review)));
    expect(answerDigest(review)).toBe(answerDigest(structuredClone(review)));
    expect(answerDigest(review)).not.toBe(answerDigest(finish(base())));
  });
});

describe("research in the agent's words", () => {
  test("describeReview names the answer path, claim counts and the draft", () => {
    const text = describeReview(finish(draft(base(), "Says [C9].", ["It cites C9, which no claim has."])));
    expect(text).toContain("/repo/journal/brief-answer.md");
    expect(text).toContain("Claims (3): 2 agreed, 1 unverified");
    expect(text).toContain("- C1 [RQ1, fact, agreed]");
    expect(text).toContain("checks: verified");
    expect(text).toContain("Latest draft: revision 0");
    expect(text).toContain("It cites C9");
  });

  test("finishedPrompt says where the answer was written", () => {
    let review = reduce(finish(draft(base(), "A [C1].")), { type: "answer-written", at: 20, path: "/repo/journal/brief-answer.md", digest: "d" });
    const text = finishedPrompt(review);
    expect(text).toContain("research council rev1");
    expect(text).toContain("/repo/journal/brief-answer.md");
    expect(text).toContain("Answer tab");
  });

  test("a review's describeReview is unchanged", () => {
    const review = reduce(newReview("r", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }] }, "mock", 0), { type: "started", at: 1 });
    expect(describeReview(review)).toContain("Spectra Council review r of /repo");
    expect(describeReview(review)).toContain("No findings yet.");
  });
});
