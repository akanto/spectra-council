import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Review } from "../core/model.ts";
import { newReview, reduce, type ReviewEvent } from "../core/review.ts";
import { ActionPlan } from "../view/Actions.tsx";
import { FixerContext } from "../view/ui.tsx";

/** A complete review with F1 accepted, and the events given after it. */
function review(...more: ReviewEvent[]): Review {
  let r = newReview("rev1", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }] }, "mock", 0);
  const events: ReviewEvent[] = [
    { type: "started", at: 1 },
    { type: "reviewer-started", reviewerId: "r1", at: 2 },
    { type: "finding-reported", reviewerId: "r1", at: 3, finding: { title: "T", summary: "S", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 3 }] } },
    { type: "reviewer-finished", reviewerId: "r1", at: 4, outcome: "completed" },
    { type: "concluded", at: 5, summary: "Done." },
    { type: "ruled", at: 6, findingId: "F1", decision: "accepted", note: "" },
    ...more,
  ];
  for (const event of events) r = reduce(r, event);
  return r;
}

const render = (r: Review, fixer: string | null) =>
  renderToStaticMarkup(
    <FixerContext.Provider value={fixer}>
      <ActionPlan review={r} act={() => {}} busy={false} />
    </FixerContext.Provider>,
  );

describe("the ask box", () => {
  test("offers the fixer profile only when one is chosen", () => {
    expect(render(review(), null)).not.toContain("Send to");
    expect(render(review(), "codex")).toContain("Send to codex");
  });

  test("says where the last ask went and how far it got", () => {
    const asked: ReviewEvent = { type: "asked", at: 7, text: "Fix it", findingIds: ["F1"], profile: "codex" };
    expect(render(review({ type: "asked", at: 7, text: "Fix it", findingIds: ["F1"] }), null)).toContain("Last asked: “Fix it”");
    expect(render(review(asked), "codex")).toContain("Asked codex · starting… · “Fix it”");
    const delegated: ReviewEvent = { type: "ask-delegated", at: 8, ask: 0, conversationId: "c1" };
    expect(render(review(asked, delegated), "codex")).toContain("Asked codex · working… ·");
    expect(render(review(asked, delegated, { type: "ask-answered", at: 9, ask: 0, problem: null }), "codex")).toContain("Asked codex · answered ·");
    expect(render(review(asked, delegated, { type: "ask-answered", at: 9, ask: 0, problem: "codex failed." }), "codex")).toContain("Asked codex · codex failed. ·");
  });
});
