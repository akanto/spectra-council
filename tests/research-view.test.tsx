import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Review } from "../core/model.ts";
import { newReview, reduce, type ReviewEvent } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";
import { AnswerTab, answerBlocks, ClaimsTab } from "../view/Research.tsx";
import { Setup } from "../view/Setup.tsx";

const claim: ClaimInput = { rq: "RQ1", kind: "fact", title: "Cohorts filter on series", text: "IDC filters on **series** attributes.", confidence: "high", fields: { "DICOM level": "series" }, sources: [{ url: "https://doi.org/10.1/1", doi: "10.1/1", authors: "A. Author", title: "A paper", venue: "Proc. X", year: 2024, quote: "filters on series", read: "full-text" }] };

const answer = "# Findings\n\nCohorts filter on series [C1].\n\n| Level | Source |\n| --- | --- |\n| series | [C1] |\n";

function fixture(...more: ReviewEvent[]): Review {
  let r = newReview("rev1", { kind: "research", target: "/repo", brief: "/repo/brief.md", profile: "general", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }, { agent: "mock-codex", enabled: true }] }, "mock", 0);
  const events: ReviewEvent[] = [
    { type: "started", at: 1 },
    { type: "reviewer-started", reviewerId: "r1", at: 2 },
    { type: "reviewer-started", reviewerId: "r2", at: 2 },
    { type: "claim-reported", reviewerId: "r1", at: 3, claim },
    { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" },
    { type: "reviewer-finished", reviewerId: "r2", at: 4, outcome: "completed" },
    { type: "deliberation-started", at: 5, rounds: 1 },
    { type: "source-checked", reviewerId: "r2", at: 6, check: { claimId: "C1", source: 1, outcome: "verified", note: "Opened it." } },
    { type: "sources-checked", at: 6 },
    { type: "synthesis-started", at: 7 },
    { type: "claim-resolved", at: 8, claimId: "C1", status: "agreed", rationale: "Everyone backs it.", dissenters: [] },
    { type: "answer-drafted", reviewerId: "r1", at: 9, markdown: answer, problems: [] },
    { type: "answer-written", at: 10, path: "/repo/brief-answer.md", digest: "d" },
    { type: "concluded", at: 11, summary: "1 claim." },
    ...more,
  ];
  for (const event of events) r = reduce(r, event);
  return r;
}

const noop = () => {};

describe("the answer's Markdown", () => {
  test("splits headings and tables from prose", () => {
    const kinds = answerBlocks(answer).map((block) => block.kind);
    expect(kinds).toEqual(["heading", "md", "table"]);
  });
});

describe("the Answer tab", () => {
  test("renders the latest draft with citations as buttons, and the file path", () => {
    const html = renderToStaticMarkup(<AnswerTab review={fixture()} act={noop} busy={false} select={noop} />);
    expect(html).toContain("Findings");
    expect(html).toContain("<table");
    expect(html).toContain('class="link finding-ref"');
    expect(html).toContain("/repo/brief-answer.md");
    expect(html).toContain("Send follow-up");
    expect(html).not.toContain("Revise answer");
  });

  test("offers Revise answer once a claim was struck", () => {
    const html = renderToStaticMarkup(<AnswerTab review={fixture({ type: "claim-ruled", at: 12, claimId: "C1", decision: "struck", note: "" })} act={noop} busy={false} select={noop} />);
    expect(html).toContain("Revise answer");
  });
});

describe("the Claims tab", () => {
  test("groups by research question and shows an open claim's sources and checks", () => {
    const html = renderToStaticMarkup(<ClaimsTab review={fixture()} focus="C1" select={noop} act={noop} busy={false} />);
    expect(html).toContain("RQ1");
    expect(html).toContain("Cohorts filter on series");
    expect(html).toContain("verified");
    expect(html).toContain("DICOM level");
    expect(html).toContain("Keep");
    expect(html).toContain("Strike");
  });

  test("marks a struck claim", () => {
    const html = renderToStaticMarkup(<ClaimsTab review={fixture({ type: "claim-ruled", at: 12, claimId: "C1", decision: "struck", note: "" })} focus={null} select={noop} act={noop} busy={false} />);
    expect(html).toContain("Struck");
  });
});

describe("the research setup", () => {
  test("shows the brief, answer file, editor and focus, not the review profile", () => {
    const review = newReview("rev1", { kind: "research", target: "/repo", brief: "/repo/brief.md", profile: "general", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }, { agent: "mock-codex", enabled: true }] }, "mock", 0);
    const html = renderToStaticMarkup(<Setup review={review} configure={noop} start={async () => ({})} busy={false} />);
    expect(html).toContain("Brief");
    expect(html).toContain("/repo/brief-answer.md");
    expect(html).toContain("Editor");
    expect(html).toContain("Focus");
    expect(html).toContain("claims per researcher");
    expect(html).not.toContain("Review profile");
    expect(html).toContain("Start research");
  });
});
