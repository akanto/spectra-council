import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { acceptedFindings, handoffFile, handoffMarkdown, prose } from "../core/handoff.ts";
import type { Review } from "../core/model.ts";
import { newReview, reduce, type ReviewEvent } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";

const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: defaultSeats() };

const base: FindingInput = {
  title: "Off by one",
  summary: "The loop drops the last element.",
  severity: "medium",
  confidence: "high",
  category: "correctness",
  evidence: [{ path: "src/a.ts", line: 3, endLine: 5, quote: "for (i = 0; i < n - 1; i++)" }],
  recommendation: "Loop to n.",
};

const apply = (review: Review, ...events: ReviewEvent[]) => events.reduce(reduce, review);

/** F1 low (confirmed), F2 critical (disputed, Codex dissents), F3 high (agreed, no proposal). */
function concluded(runner: "mock" | "mirador" = "mirador"): Review {
  return apply(
    newReview("rev1", setup, runner, 0),
    { type: "started", at: 10 },
    { type: "reviewer-started", reviewerId: "r1", at: 11 },
    { type: "reviewer-started", reviewerId: "r2", at: 11 },
    { type: "finding-reported", reviewerId: "r1", at: 12, finding: { ...base, title: "Minor nit", severity: "low" } },
    { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...base, title: "Race on cache", severity: "critical", recommendation: undefined } },
    { type: "finding-reported", reviewerId: "r2", at: 14, finding: { ...base, title: "Leaky handle", severity: "high", recommendation: "Close the handle in a finally." } },
    { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" },
    { type: "reviewer-finished", reviewerId: "r2", at: 20, outcome: "completed" },
    { type: "deliberation-started", at: 30, rounds: 2 },
    { type: "round-started", at: 31, round: 1 },
    { type: "argued", reviewerId: "r2", at: 32, argument: { findingId: "F2", stance: "challenges", confidence: "medium", text: "The lock\n  is held by the caller.", evidence: [{ path: "src/cache.ts", line: 9, note: "caller locks" }] } },
    { type: "argued", reviewerId: "r2", at: 33, argument: { findingId: "F1", stance: "supports", confidence: "high", text: "Confirmed.", evidence: [] } },
    { type: "synthesis-started", at: 40 },
    { type: "finding-resolved", at: 41, findingId: "F1", status: "confirmed", rationale: "Both back it.", dissenters: [] },
    { type: "finding-resolved", at: 41, findingId: "F2", status: "disputed", rationale: "Codex's challenge stands.", dissenters: ["r2"] },
    { type: "finding-resolved", at: 41, findingId: "F3", status: "agreed", rationale: "Nobody objected.", dissenters: [] },
    {
      type: "fix-proposed",
      reviewerId: "r1",
      at: 42,
      proposal: { findingId: "F1", summary: "Loop to n.", steps: ["Change the bound", "Add a test"], files: ["src/a.ts"], verification: "bun test", risks: "None." },
    },
    {
      type: "fix-proposed",
      reviewerId: "r1",
      at: 42,
      proposal: { findingId: "F2", summary: "Take the lock.", steps: ["Lock in get()"], files: ["src/cache.ts"], verification: "Run the race test." },
    },
    { type: "concluded", at: Date.UTC(2026, 10, 2, 12), summary: "Three findings stand." },
  );
}

const ruled = (review: Review) =>
  apply(
    review,
    { type: "ruled", at: 60, findingId: "F1", decision: "accepted", note: "" },
    { type: "ruled", at: 60, findingId: "F2", decision: "accepted", note: "Go with the dissent: check the caller." },
    { type: "ruled", at: 60, findingId: "F3", decision: "dismissed", note: "Not worth it" },
  );

describe("handoff", () => {
  test("the file lives under .spectra-council", () => {
    expect(handoffFile(concluded())).toBe(".spectra-council/review-rev1.md");
  });

  test("only accepted findings get sections, most severe first; the rest are listed last", () => {
    const review = ruled(concluded());
    expect(acceptedFindings(review).map((finding) => finding.id)).toEqual(["F2", "F1"]);
    const md = handoffMarkdown(review);
    expect(md).toContain("## F2: Race on cache");
    expect(md).toContain("## F1: Minor nit");
    expect(md).not.toContain("## F3:");
    expect(md.indexOf("## F2:")).toBeLessThan(md.indexOf("## F1:"));
    expect(md).toContain("2026-11-02");
    expect(md).toContain("council_mark_fixed");
    expect(md).toContain("| F2 | critical | disputed | Race on cache |");
    // The council line spells out each seat's name; the rest of the file calls them R1, R2, ….
    expect(md).toContain("(R1 · Claude (mock); R2 · Codex (mock))");
    const notToFix = md.slice(md.indexOf("## Not to fix"));
    expect(notToFix).toContain("F3 (dismissed): Leaky handle - Not worth it");
    expect(notToFix).not.toContain("F1");
  });

  test("a disputed finding carries a minority report naming the dissenter", () => {
    const md = handoffMarkdown(ruled(concluded()));
    const f2 = md.slice(md.indexOf("## F2:"), md.indexOf("## F1:"));
    expect(f2).toContain("Minority report");
    expect(f2).toContain("Codex");
    expect(f2).toContain("> R2 (round 1): The lock is held by the caller.");
    expect(f2).toContain("src/cache.ts:9");
    expect(f2).toContain("Go with the dissent");
    expect(md.slice(md.indexOf("## F1:"))).not.toContain("Minority report");
    expect(f2.indexOf("Minority report")).toBeLessThan(f2.indexOf("### Evidence"));
  });

  test("a finding other reviewers found on their own names them; one nobody else found doesn't", () => {
    const merged = apply(
      newReview("rev1", setup, "mirador", 0),
      { type: "started", at: 10 },
      { type: "reviewer-started", reviewerId: "r1", at: 11 },
      { type: "reviewer-started", reviewerId: "r2", at: 11 },
      { type: "finding-reported", reviewerId: "r1", at: 12, finding: base },
      { type: "finding-reported", reviewerId: "r2", at: 13, finding: { ...base, title: "Last element dropped" } },
      { type: "finding-reported", reviewerId: "r1", at: 14, finding: { ...base, title: "Leaky handle" } },
      { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" },
      { type: "reviewer-finished", reviewerId: "r2", at: 20, outcome: "completed" },
      { type: "findings-merged", at: 21, into: "F1", merged: ["F2"] },
      { type: "deliberation-started", at: 30, rounds: 1 },
      { type: "synthesis-started", at: 40 },
      { type: "finding-resolved", at: 41, findingId: "F1", status: "agreed", rationale: "All 2 reviewers back it.", dissenters: [] },
      { type: "finding-resolved", at: 41, findingId: "F3", status: "confirmed", rationale: "1 of 2 back it.", dissenters: [] },
      { type: "concluded", at: 50, summary: "Two findings stand." },
      { type: "ruled", at: 60, findingId: "F1", decision: "accepted", note: "" },
      { type: "ruled", at: 60, findingId: "F3", decision: "accepted", note: "" },
    );
    const md = handoffMarkdown(merged);
    const f1 = md.slice(md.indexOf("## F1:"), md.indexOf("## F3:"));
    expect(f1).toContain("- Reported by: R1, high confidence\n- Also found independently by: R2\n");
    expect(md.slice(md.indexOf("## F3:"))).not.toContain("Also found independently");
  });

  test("proposal steps are numbered, with files, verification and risks", () => {
    const md = handoffMarkdown(ruled(concluded()));
    expect(md).toContain("1. Change the bound\n2. Add a test");
    expect(md).toContain("`src/a.ts:3-5`");
    expect(md).toContain("> for (i = 0; i < n - 1; i++)");
    expect(md).toContain("How to verify: bun test");
    expect(md).toContain("Risks: None.");
  });

  test("without a proposal the recommendation is the fallback", () => {
    const review = apply(ruled(concluded()), { type: "ruled", at: 61, findingId: "F3", decision: "accepted", note: "" });
    const md = handoffMarkdown(review);
    const f3 = md.slice(md.indexOf("## F3:"), md.indexOf("## F1:"));
    expect(f3).toContain("No fix was proposed.");
    expect(f3).toContain("Close the handle in a finally.");
  });

  test("a reopened fix shows why", () => {
    let review = apply(
      ruled(concluded()),
      { type: "handoff-written", at: 70, path: "/repo/.spectra-council/review-rev1.md", findingIds: ["F1", "F2"] },
      { type: "fix-requested", at: 71, findingIds: ["F1", "F2"] },
      { type: "fix-reported", at: 72, findingId: "F1", summary: "Changed the bound", files: ["src/a.ts"] },
      { type: "verification-started", at: 73, findingIds: ["F1"], reviewerIds: ["r2"] },
      { type: "fix-checked", reviewerId: "r2", at: 74, check: { findingId: "F1", outcome: "reopened", text: "Still skips the empty list case.", evidence: [{ path: "src/a.ts", line: 4 }] } },
      { type: "verification-ended", at: 75 },
    );
    expect(review.findings[0]!.fix?.state).toBe("reopened");
    const md = handoffMarkdown(review);
    expect(md).toContain("State: reopened.");
    expect(md).toContain("R2 (check 1): Still skips the empty list case.");
    expect(md).toContain("Reported change: Changed the bound");
  });

  test("a mock review says so", () => {
    expect(handoffMarkdown(ruled(concluded("mock")))).toContain("deterministic mocks");
    expect(handoffMarkdown(ruled(concluded("mirador")))).not.toContain("deterministic mocks");
  });
});


test("accepted uncorroborated reports use recommendations and exclude dismissed or deferred reports", () => {
  const review = ruled(concluded());
  review.rounds = 0;
  for (const finding of review.findings) {
    finding.status = "reported";
    finding.resolution = null;
    finding.proposal = null;
  }
  const deferred = apply(review, { type: "ruled", at: 61, findingId: "F2", decision: "deferred", note: "" });
  expect(acceptedFindings(deferred).map((finding) => finding.id)).toEqual(["F1"]);
  const md = handoffMarkdown(deferred);
  expect(md).toContain("Loop to n.");
  expect(md).toContain("council status: reported");
  expect(md).not.toContain("## F2:");
  expect(md).not.toContain("## F3:");
});

describe("prose", () => {
  test("keeps paragraphs and lists, and can't open a heading or a tag", () => {
    expect(prose("Impact first.\n\n\n\nCause:\n- step one\n- step two  ")).toBe("Impact first.\n\nCause:\n- step one\n- step two");
    expect(prose("# Not a heading\n<script>x</script>")).toBe("\\# Not a heading\n&lt;script>x&lt;/script>");
  });

  test("code stays verbatim; rules, setext underlines and open fences can't break the document", () => {
    expect(prose("Uses `Array<string>` and `a < b`, not <b>")).toBe("Uses `Array<string>` and `a < b`, not &lt;b>");
    expect(prose("Impact.\n---\nmore\n=====")).toBe("Impact.\n\\---\nmore\n\\=====");
    expect(prose("Example:\n```ts\n# comment\nconst a = b < c;\n```")).toBe("Example:\n```ts\n# comment\nconst a = b < c;\n```");
    expect(prose("Example:\n```ts\nfoo()")).toBe("Example:\n```ts\nfoo()\n```");
    expect(prose("- a list item stays")).toBe("- a list item stays");
  });
});
