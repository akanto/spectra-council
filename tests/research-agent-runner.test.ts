import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../core/agent-runner.ts";
import { claimGroupingPrompt, deliberationPrompt, draftCheckPrompt, draftPrompt, researchPrompt, sourceCheckPrompt } from "../core/agent-turns.ts";
import type { AgentReply, Conversations, Report } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview } from "../core/review.ts";
import type { ClaimInput } from "../core/schemas.ts";
import { FakeClock } from "./support.ts";

class Fake implements Conversations {
  prompts: { prompt: string; turn?: string }[] = [];
  constructor(private text: string) {}
  async ask({ profile, prompt, turn, signal }: Parameters<Conversations["ask"]>[0]): Promise<AgentReply> {
    this.prompts.push({ prompt, turn });
    if (this.text === "never") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    return { conversationId: "c1", profile, ended: "finished", text: this.text };
  }
}

const json = (value: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const source = { url: "https://doi.org/10.1/1", authors: "A. Author", title: "Paper One", venue: "Proc. X", year: 2024, quote: "quote one", read: "full-text" as const };
const claim: ClaimInput = { rq: "RQ1", kind: "fact", title: "Metadata dominates", text: "Most queries filter on metadata.", confidence: "high", fields: { "DICOM level": "series" }, sources: [source] };

const seats = [
  { agent: "profile:alpha", enabled: true, focus: "RQ2 and database venues" },
  { agent: "profile:beta", enabled: true },
];
const make = (extra: Partial<Parameters<typeof newReview>[1]> = {}): Review =>
  newReview("rev", { kind: "research", target: "/repo", brief: "/repo/journal/brief.md", profile: "general", depth: "quick", instructions: "Mind the dates.", seats, ...extra }, "mirador", 0);

/** A review with C1 (reported by r1, checked by r2, agreed) so the ledger has something in it, as after the rounds. */
function withClaims(review: Review): Review {
  const { rq, kind, title, text, confidence, fields } = claim;
  const ledgerClaim = {
    id: "C1", reviewerId: "r1", pass: 0, rq, kind, title, text, confidence, fields,
    sources: [{ ...source, checks: [{ reviewerId: "r2", outcome: "verified" as const, note: "Opened the PDF.", at: 2 }] }],
    status: "agreed" as const, reportedAt: 1, positions: [], resolution: null, alsoReported: [], ruling: null,
  };
  return { ...review, rounds: 2, research: { ...review.research!, claims: [ledgerClaim], claimsIssued: 1 } };
}

const job = (review: Review, id = "r1") => ({ review, reviewer: review.reviewers.find((each) => each.id === id)!, profile: PROFILES[review.profile] });

async function run(text: string, go: (runner: AgentRunner, report: (r: Report) => void) => Promise<void>, limitMs?: number) {
  const reports: Report[] = [];
  const conversations = new Fake(text);
  const clock = new FakeClock();
  const runner = new AgentRunner(conversations, clock, limitMs);
  const done = go(runner, (r) => reports.push(r));
  const settled = done.then(() => null, (error: Error) => error);
  const outcome = await Promise.race([settled, clock.settle().then(() => "pending" as const)]);
  return { reports, conversations, clock, outcome, settled };
}

describe("research turns", () => {
  const review = withClaims(make());
  const ac = () => new AbortController().signal;

  test("the research turn reports each claim", async () => {
    const { reports, conversations } = await run(json({ webAccess: true, claims: [claim, claim] }), (r, rep) => r.research(job(make()), rep, ac()));
    expect(reports.filter((x) => x.type === "claim-reported")).toHaveLength(2);
    expect(JSON.parse(conversations.prompts[0]!.turn!)).toEqual(["rev", "r1", "research", "pass 0", "ask"]);
  });

  test("webAccess false fails the seat", async () => {
    const { outcome, reports } = await run(json({ webAccess: false, claims: [] }), (r, rep) => r.research(job(make()), rep, ac()));
    expect((outcome as Error).message).toBe("It has no web access: give its profile web search and fetch, or seat another profile.");
    expect(reports.some((x) => x.type === "claim-reported")).toBe(false);
  });

  test("source checks, draft and draft checks become reports", async () => {
    const checks = [{ claimId: "C1", source: 1, outcome: "verified", note: "ok" }];
    const sc = await run(json({ checks }), (r, rep) => r.checkSources({ ...job(review, "r2"), claimIds: ["C1"] }, rep, ac()));
    expect(sc.reports.filter((x) => x.type === "source-checked")).toHaveLength(1);
    const dr = await run(json({ answer: "Hello [C1]" }), (r, rep) => r.draft({ ...job(review), revision: 0, previous: null, objections: [], problems: [] }, rep, ac()));
    expect(dr.reports.find((x) => x.type === "answer-drafted")).toEqual({ type: "answer-drafted", markdown: "Hello [C1]" });
    expect(JSON.parse(dr.conversations.prompts[0]!.turn!).slice(2)).toEqual(["draft", "pass 0", "revision 0", "ask"]);
    const draft = { editorId: "r1", pass: 0, revision: 1, markdown: "Hello [C1]", problems: [], at: 1 };
    const ck = await run(json({ objections: [{ claimId: "C1", excerpt: "Hello", problem: "x" }] }), (r, rep) => r.checkDraft({ ...job(review, "r2"), draft }, rep, ac()));
    expect(ck.reports.filter((x) => x.type === "draft-objected")).toHaveLength(1);
    expect(JSON.parse(ck.conversations.prompts[0]!.turn!).slice(2)).toEqual(["check-draft", "pass 0", "revision 1", "ask"]);
  });

  test("the research prompt names the brief, the focus and the instructions; a question stands in for a missing brief", () => {
    const prompt = researchPrompt(job(make()));
    expect(prompt.split("\n")[0]).toContain("Research");
    expect(prompt).toContain("Read the brief at /repo/journal/brief.md");
    expect(prompt).toContain("lean towards RQ2 and database venues");
    expect(prompt).toContain("Mind the dates.");
    expect(researchPrompt(job(make(), "r2"))).not.toContain("lean towards");
    const typed = researchPrompt(job(make({ brief: "", question: "How big is the PACS market?" })));
    expect(typed).toContain("How big is the PACS market?");
    expect(typed).not.toContain("Read the brief at");
  });

  test("a follow-up prompt carries its question and the known claims", () => {
    const base = withClaims(make());
    const followed: Review = { ...base, research: { ...base.research!, pass: 1, followUps: [{ question: "Look at RSNA 2018.", at: 5, pass: 1, startedAt: 5 }] } };
    const prompt = researchPrompt(job(followed));
    expect(prompt).toContain("Look at RSNA 2018.");
    expect(prompt).toContain("C1 [agreed] Metadata dominates");
    expect(prompt).toContain("Paper One");
  });

  test("the draft prompt carries the ledger, and a revision the objections", () => {
    const first = draftPrompt({ ...job(review), revision: 0, previous: null, objections: [], problems: [] });
    expect(first).toContain("C1 reported by r1: Metadata dominates");
    expect(first).toContain("checked by r2: verified");
    expect(first).toContain("DICOM level: series");
    expect(first).toContain("[C3, C7]");
    const draft = { editorId: "r1", pass: 0, revision: 0, markdown: "First text [C1]", problems: [], at: 1 };
    const objection = { id: "O1", reviewerId: "r2", pass: 0, revision: 0, claimId: "C1", excerpt: "First text", problem: "overstated", at: 2 };
    const second = draftPrompt({ ...job(review), revision: 1, previous: draft, objections: [objection], problems: ["It cites C9, which no claim has."] });
    expect(second).toContain("First text [C1]");
    expect(second).toContain("overstated");
    expect(second).toContain("C9");
    const check = draftCheckPrompt({ ...job(review, "r2"), draft });
    expect(check).toContain("First text [C1]");
    expect(check).toContain("Metadata dominates");
  });

  test("grouping, source-check and deliberation prompts list the claims", () => {
    expect(claimGroupingPrompt(job(review))).toContain("C1 reported by r1");
    expect(sourceCheckPrompt({ ...job(review, "r2"), claimIds: ["C1"] })).toContain("source 1:");
    const deliberating = deliberationPrompt({ ...job(review, "r1"), round: 1, rounds: 2 });
    expect(deliberating).toContain("THIS IS YOUR OWN CLAIM");
    expect(deliberating).toContain("checked by r2: verified");
  });
});

describe("research turn limits", () => {
  const ac = () => new AbortController().signal;
  const review = withClaims(make());
  const minutes = async (go: (runner: AgentRunner, report: (r: Report) => void) => Promise<void>, limitMs?: number) => {
    const reports: Report[] = [];
    const clock = new FakeClock();
    const runner = new AgentRunner(new Fake("never"), clock, limitMs);
    const done = go(runner, (r) => reports.push(r)).then(() => "", (error: Error) => error.message);
    await clock.settle();
    await clock.runAll();
    return done;
  };

  test("60 minutes for research, 20 for a draft, and a given limit overrides", async () => {
    expect(await minutes((r, rep) => r.research(job(make()), rep, ac()))).toBe("Its turn took longer than 60 minutes");
    expect(await minutes((r, rep) => r.draft({ ...job(review), revision: 0, previous: null, objections: [], problems: [] }, rep, ac()))).toBe("Its turn took longer than 20 minutes");
    expect(await minutes((r, rep) => r.research(job(make()), rep, ac()), 5 * 60_000)).toBe("Its turn took longer than 5 minutes");
  });
});
