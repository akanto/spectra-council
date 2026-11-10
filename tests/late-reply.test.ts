import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replyFetched, type LateReply } from "../core/agent-runner.ts";
import { verdictSummary } from "../core/deliberation.ts";
import { lateReplyPrompt } from "../core/describe.ts";
import { ReviewSession, type ReviewerRunner } from "../core/engine.ts";
import { canFetchReply, lastTurnOf, whenFetchable, whyNoFetch } from "../core/late-replies.ts";
import { isRulable, type Review } from "../core/model.ts";
import { newReview, reduce, reopensWith, ReviewError, type ReplyFetched } from "../core/review.ts";
import type { FindingInput } from "../core/schemas.ts";
import { createCouncilHost, IN_FLIGHT_KEY, TURN_LIMIT_SETTING, turnLimitOf } from "../hosts/mirador/host.ts";
import type { MiradorRecords } from "../hosts/mirador/records.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const finding = (title: string, severity: FindingInput["severity"] = "medium"): FindingInput => ({
  title,
  summary: `${title} is wrong.`,
  severity,
  confidence: "high",
  category: "correctness",
  evidence: [{ path: "README.md", line: 1 }],
});
const json = (value: unknown, prose = "Done.") => `${prose}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const seats = (agents: string[]) => agents.map((agent) => ({ agent, enabled: true }));
const fresh = (agents = ["profile:alpha", "profile:beta"], maxFindings?: number) =>
  newReview("rev", { target: "/repo", profile: "code", depth: "quick", instructions: "", seats: seats(agents), ...(maxFindings ? { maxFindings } : {}) }, "mirador", 0);

/** Alpha reported one finding; beta's review turn ran in conversation c-beta and timed out. Still in the independent review. */
function timedOut(review = fresh()): Review {
  let next = reduce(review, { type: "started", at: 1 });
  for (const reviewerId of ["r1", "r2"]) next = reduce(next, { type: "reviewer-started", reviewerId, at: 2 });
  next = reduce(next, { type: "activity", reviewerId: "r2", at: 3, kind: "status", text: "Asking the beta profile to review" });
  next = reduce(next, { type: "activity", reviewerId: "r2", at: 3, kind: "tool", text: "Started conversation c-beta" });
  next = reduce(next, { type: "finding-reported", reviewerId: "r1", at: 4, finding: finding("Alpha's") });
  next = reduce(next, { type: "reviewer-finished", reviewerId: "r1", at: 5, outcome: "completed" });
  return reduce(next, { type: "reviewer-finished", reviewerId: "r2", at: 6, outcome: "failed", problem: "Its turn took longer than 15 minutes" });
}

/** The same review, concluded without a deliberation, as the engine does with one reviewer finished. */
const concluded = (review = timedOut()) => reduce(review, { type: "concluded", at: 7, summary: verdictSummary(review) });

const fetched = (findings: FindingInput[] = [finding("Beta's")], extra: Partial<ReplyFetched> = {}): ReplyFetched => ({
  type: "reply-fetched",
  reviewerId: "r2",
  at: 100,
  conversationId: "c-beta",
  note: "I read the code.",
  findings,
  rejected: [],
  ...extra,
});

describe("a seat's last turn and whether its reply can be fetched", () => {
  test("the turn and conversation come from its activity; the repair's conversation is the latest", () => {
    const review = timedOut();
    expect(lastTurnOf(review.reviewers[1]!)).toEqual({ what: "to review", conversationId: "c-beta" });
    const repaired = reduce(reduce(timedOut(), { type: "reviewer-retried", reviewerId: "r2", at: 7 }), { type: "reviewer-started", reviewerId: "r2", at: 8 });
    let next = reduce(repaired, { type: "activity", reviewerId: "r2", at: 9, kind: "status", text: "Asking the beta profile to review" });
    next = reduce(next, { type: "activity", reviewerId: "r2", at: 9, kind: "tool", text: "Started conversation c-2" });
    next = reduce(next, { type: "activity", reviewerId: "r2", at: 9, kind: "error", text: "Its reply had no valid JSON block; asking again" });
    next = reduce(next, { type: "activity", reviewerId: "r2", at: 9, kind: "tool", text: "Started conversation c-3" });
    expect(lastTurnOf(next.reviewers[1]!)).toEqual({ what: "to review", conversationId: "c-3" });
    expect(lastTurnOf(fresh().reviewers[0]!)).toBeNull();
  });

  test("a failed profile seat's own review, in the independent review or once complete", () => {
    const running = timedOut();
    expect(whyNoFetch(running, running.reviewers[1]!)).toBeNull();
    expect(canFetchReply(concluded(), concluded().reviewers[1]!)).toBe(true);
    expect(whyNoFetch(running, running.reviewers[0]!)).toContain("hasn't failed");
    const deliberating = { ...concluded(), phase: "deliberation" as const };
    expect(whyNoFetch(deliberating, deliberating.reviewers[1]!)).toContain("once the review is complete");
    const stopped = { ...concluded(), phase: "stopped" as const };
    expect(whyNoFetch(stopped, stopped.reviewers[1]!)).toContain("it is stopped");
  });

  test("when it can be fetched: now, once the council at work is done, once a cut-short run is resumed, or not at all", () => {
    const review = concluded();
    expect(whenFetchable(review, review.reviewers[1]!)).toBe("now");
    for (const phase of ["deliberation", "synthesis", "verification"] as const) {
      const atWork = { ...review, phase };
      expect(whenFetchable(atWork, atWork.reviewers[1]!)).toBe("once complete");
    }
    const stopped = { ...review, phase: "stopped" as const };
    expect(whenFetchable(stopped, stopped.reviewers[1]!)).toBeNull();
    const deliberating = { ...review, phase: "deliberation" as const };
    const inRound = { ...deliberating.reviewers[1]!, activity: [...deliberating.reviewers[1]!.activity, { seq: 9, at: 9, kind: "status" as const, text: "Asking the beta profile to argue round 2" }] };
    expect(whenFetchable(deliberating, inRound)).toBeNull();
    const cutShort = reduce(timedOut(), { type: "interrupted", at: 7 });
    expect(whenFetchable(cutShort, cutShort.reviewers[1]!)).toBe("once resumed");
    const inRoundCutShort = { ...cutShort.reviewers[1]!, activity: [...cutShort.reviewers[1]!.activity, { seq: 9, at: 9, kind: "status" as const, text: "Asking the beta profile to argue round 2" }] };
    expect(whenFetchable(cutShort, inRoundCutShort)).toBeNull();
  });

  test("a window told while the council works says what a stop leaves, since a stopped review refuses the fetch", () => {
    const deliberating = { ...concluded(), phase: "deliberation" as const };
    const seat = deliberating.reviewers[1]!;
    expect(lateReplyPrompt(deliberating, seat, whenFetchable(deliberating, seat)!)).toContain(`once the review reaches its verdict; if it never gets there, the reply stays only in ${seat.label}'s own conversation`);
    const stopped = { ...deliberating, phase: "stopped" as const };
    expect(whenFetchable(stopped, stopped.reviewers[1]!)).toBeNull();
    expect(whyNoFetch(stopped, stopped.reviewers[1]!)).toContain("it is stopped");
  });

  test("not a seat that failed in a round, nor one with no conversation, nor a mock", () => {
    const review = concluded();
    const inRound = { ...review.reviewers[1]!, activity: [...review.reviewers[1]!.activity, { seq: 9, at: 9, kind: "status" as const, text: "Asking the beta profile to argue round 2" }] };
    expect(whyNoFetch(review, inRound)).toContain("when asked to argue round 2");
    const unstarted = { ...review.reviewers[1]!, activity: review.reviewers[1]!.activity.filter((activity) => activity.kind !== "tool") };
    expect(whyNoFetch(review, unstarted)).toContain("never started a conversation");
    expect(whyNoFetch(review, { ...review.reviewers[1]!, agent: "mock-qwen" })).toContain("no conversation of its own");
  });
});

describe("replyFetched: reading a late reply as the runner reads one", () => {
  const reply = (text: string | null, ended: LateReply["ended"] = "finished"): LateReply => ({ text, ended });

  test("its prose, its findings, and the malformed ones rejected", () => {
    const event = replyFetched("r2", "c-beta", reply(json({ findings: [finding("One"), { title: "no summary" }] }, "Read the [code](src/a.ts).")), 50);
    expect(event).toMatchObject({ type: "reply-fetched", reviewerId: "r2", at: 50, conversationId: "c-beta", note: "Read the code." });
    expect(event.findings.map((each) => each.title)).toEqual(["One"]);
    expect(event.rejected).toHaveLength(1);
    expect(event.rejected[0]).toContain("summary");
  });

  test("a turn still running, ended badly, or with no valid JSON block can't be used", () => {
    expect(() => replyFetched("r2", "c-beta", reply(null, "running"), 50)).toThrow("still working");
    expect(() => replyFetched("r2", "c-beta", reply("x", "failed"), 50)).toThrow("failed before it replied");
    expect(() => replyFetched("r2", "c-beta", reply("x", "stopped"), 50)).toThrow("was stopped");
    expect(() => replyFetched("r2", "c-beta", reply("All fine, no JSON."), 50)).toThrow("no fenced ```json block");
  });
});

describe("reply-fetched", () => {
  test("in the independent review: the seat completes with the reply's findings, logged as its run would be", () => {
    const next = reduce(timedOut(), fetched());
    expect(next.reviewers[1]).toMatchObject({ status: "completed", problem: null, current: "Review complete", endedAt: 100 });
    expect(next.findings.map((each) => [each.id, each.reviewerId, each.title, each.late])).toEqual([
      ["F1", "r1", "Alpha's", undefined],
      ["F2", "r2", "Beta's", undefined],
    ]);
    expect(next.findingsIssued).toBe(2);
    expect(next.reviewers[1]!.activity.slice(-4).map((each) => `${each.kind}: ${each.text}`)).toEqual([
      "status: Took its late reply from conversation c-beta",
      "note: I read the code.",
      "finding: Reported F2: Beta's",
      "status: Reported 1 finding",
    ]);
  });

  test("the rejected findings show as errors, and those past the limit are dropped", () => {
    const next = reduce(timedOut(fresh(undefined, 1)), fetched([finding("Minor", "low"), finding("Major", "high")], { rejected: ["summary: Required"] }));
    expect(next.findings.filter((each) => each.reviewerId === "r2").map((each) => each.title)).toEqual(["Major"]);
    const texts = next.reviewers[1]!.activity.map((each) => `${each.kind}: ${each.text}`);
    expect(texts).toContain("error: Rejected a malformed finding: summary: Required");
    expect(texts.at(-1)).toBe("note: Kept its 1 most severe finding; dropped F2");
  });

  test("on a complete review: its findings come in late, the verdict counts them, and the agent hears anew", () => {
    const heard = reduce(concluded(), { type: "agent-heard", at: 8 });
    const next = reduce(heard, fetched());
    expect(next.phase).toBe("complete");
    expect(next.findings[1]).toMatchObject({ id: "F2", status: "reported", late: true });
    expect(next.verdict!.summary).toBe("2 findings, not deliberated: fewer than two reviewers had finished their review at the verdict. 1 came in late, from a reviewer's reply fetched after the verdict.");
    expect(next.agentHeardAt).toBeNull();
    expect(isRulable(next, next.findings[1]!)).toBe(true);
  });

  test("a late finding in a deliberated review is ruled on as reported, and counted apart from the unsettled", () => {
    const deliberated: Review = { ...concluded(), rounds: 2, verdict: { summary: "x", at: 7 } };
    const next = reduce(deliberated, fetched());
    expect(isRulable(next, next.findings[1]!)).toBe(true);
    expect(isRulable(next, next.findings[0]!)).toBe(false);
    expect(next.verdict!.summary).toContain("1 late");
    expect(next.verdict!.summary).toContain("and wasn't deliberated");
    expect(next.verdict!.summary).toContain("1 finding was left unsettled");
  });

  test("only a failed, seated reviewer, while the reviewers review or once the review is complete", () => {
    expect(() => reduce(timedOut(), fetched(undefined, { reviewerId: "r1" }))).toThrow("hasn't failed");
    expect(() => reduce(timedOut(), fetched(undefined, { reviewerId: "r9" }))).toThrow(ReviewError);
    const deliberating = { ...concluded(), phase: "deliberation" as const };
    expect(() => reduce(deliberating, fetched())).toThrow("council is at work");
    expect(() => reduce({ ...concluded(), phase: "stopped" as const }, fetched())).toThrow("it is stopped");
    const removed = reduce(concluded(), { type: "reviewer-removed", reviewerId: "r2", at: 8 });
    expect(() => reduce(removed, fetched())).toThrow("takes part");
  });
});

describe("reopened", () => {
  test("a complete review that wasn't deliberated goes back to the end of its independent review", () => {
    const next = reduce(reduce(concluded(), { type: "agent-heard", at: 8 }), { type: "reopened", at: 100 });
    expect(next).toMatchObject({ phase: "independent-review", verdict: null, endedAt: null, agentHeardAt: null });
    expect(next.reviewers.map((each) => each.status)).toEqual(["completed", "failed"]);
  });

  test("a finding taken in late before is deliberated with the rest: it is late no longer", () => {
    const withLate: Review = { ...concluded(), findings: concluded().findings.map((each) => ({ ...each, late: true as const })) };
    expect(reduce(withLate, { type: "reopened", at: 100 }).findings.every((each) => each.late === undefined)).toBe(true);
  });

  test("not one deliberated, still running, or whose findings were ruled on since", () => {
    expect(() => reduce({ ...concluded(), rounds: 2 }, { type: "reopened", at: 100 })).toThrow("deliberated this review already");
    expect(() => reduce(timedOut(), { type: "reopened", at: 100 })).toThrow("Only a complete review reopens");
    const ruled = reduce(concluded(), { type: "ruled", at: 8, findingId: "F1", decision: "accepted", note: "" });
    expect(() => reduce(ruled, { type: "reopened", at: 100 })).toThrow("ruled on or handed off");
  });

  test("reopensWith: with the reply, two reviewers finished and a finding between them", () => {
    expect(reopensWith(concluded(), fetched())).toBe(true);
    expect(reopensWith({ ...concluded(), rounds: 2 }, fetched())).toBe(false);
    expect(reopensWith(reduce(concluded(), { type: "ruled", at: 8, findingId: "F1", decision: "dismissed", note: "" }), fetched())).toBe(false);
    // Alone at the council, the reply makes only one reviewer finished.
    const alone = concluded(timedOut(fresh(["profile:beta", "profile:alpha"])));
    expect(reopensWith({ ...alone, reviewers: alone.reviewers.map((each) => (each.id === "r1" ? { ...each, status: "failed" as const } : each)) }, fetched())).toBe(false);
    const empty: Review = { ...concluded(), findings: [] };
    expect(reopensWith(empty, fetched([]))).toBe(false);
  });
});

describe("ReviewSession.reopen", () => {
  test("takes the reply in and runs the deliberation and the verdict as a run does", async () => {
    const clock = new FakeClock();
    const argued: string[] = [];
    const runner: ReviewerRunner = {
      run: async () => {},
      deliberate: async (job, report) => {
        argued.push(`${job.reviewer.id} round ${job.round}`);
        for (const { id } of job.review.findings) report({ type: "argued", argument: { findingId: id, stance: "supports", confidence: "high", text: "Holds.", evidence: [] } });
      },
      propose: async () => {},
      verify: async () => {},
    };
    const session = new ReviewSession(concluded(), { runner, clock, onChange: () => {} });
    const done = session.reopen(fetched());
    await clock.runAll();
    const review = await done;
    expect(review.phase).toBe("complete");
    expect(review.rounds).toBe(review.deliberationRounds);
    expect(argued).toEqual(["r1 round 1", "r2 round 1", "r1 round 2", "r2 round 2"]);
    expect(review.findings.map((each) => [each.title, each.status])).toEqual([
      ["Alpha's", "agreed"],
      ["Beta's", "agreed"],
    ]);
    expect(review.reviewers.map((each) => each.status)).toEqual(["completed", "completed"]);
    expect(review.verdict!.summary).toStartWith("2 findings: 2 agreed.");
  });
});

// The Mirador host: a timed-out seat's conversation stays on record, and its reply is fetched into the review.

const target = await mkdtemp(join(tmpdir(), "spectra-late-"));
await writeFile(join(target, "README.md"), "# A project\n");

/** What a profile's agent answers a turn with, told apart by the reply shape its prompt asks for. */
function answer(profile: string, prompt: string): string {
  if (prompt.includes('"proposals"')) {
    const ids = [...new Set([...prompt.matchAll(/\bF\d+\b/g)].map((match) => match[0]))];
    return json({ proposals: ids.map((findingId) => ({ findingId, summary: "Fix it.", steps: ["Change it."], files: ["README.md"], verification: "Read it." })) });
  }
  if (prompt.includes('"groups"')) return json({ groups: [] });
  if (prompt.includes('"arguments"')) return json({ arguments: [] });
  return json({ findings: [finding(`${profile} finding`)] });
}

/** Records whose replies a test sets, by conversation. */
function fakeRecords(): MiradorRecords & { replies: Map<string, LateReply> } {
  const replies = new Map<string, LateReply>();
  return { replies, profiles: () => [], modelOf: () => null, replyOf: (id) => replies.get(id) ?? null };
}

function boot(canvas = new FakeCanvas<Review>(), records = fakeRecords()) {
  const clock = new FakeClock();
  let ids = 0;
  const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => `rev${++ids}`, throttleMs: 0, writeFile: async () => {}, records, modelLookupMs: [] });
  return { clock, host, canvas, context: canvas.context(), records };
}
type Env = ReturnType<typeof boot>;

/**
 * Answers each conversation the canvas starts, but those `hold` keeps waiting, moving the clock only when none waits to
 * be answered; returns once the clock is idle, or as soon as `until` holds.
 */
async function drive({ clock, canvas, context, host }: Env, hold: (profile: string) => boolean = () => false, done = new Set<number>(), until = () => false) {
  for (let i = 0; i < 1_000; i++) {
    await clock.settle();
    if (until()) return done;
    const next = canvas.started.findIndex((started, index) => !done.has(index) && !hold(started.profile));
    if (next >= 0) {
      done.add(next);
      const started = canvas.started[next]!;
      await host.replied!({ id: `conversation-fixer-${next + 1}`, profile: started.profile }, { text: answer(started.profile, started.prompt), ended: "finished" }, context);
      continue;
    }
    if (!(await clock.step())) return done;
  }
  throw new Error("The review never settled.");
}

/** A review of alpha and beta in which beta's review turn runs past its limit (beta's conversation is the second). */
async function betaTimesOut(env: Env, agents = ["profile:alpha", "profile:beta"]) {
  await env.host.tools.council_open!.run({ target, agents, depth: "quick" }, env.context);
  const id = env.canvas.items[0]!.id;
  await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
  const done = await drive(env, (profile) => profile === "beta");
  return { id, done, beta: "conversation-fixer-2", betaPrompt: env.canvas.started[1]!.prompt };
}

/** The late reply of the first conversation the canvas started on this profile: its own review turn's. */
async function lateReplyOf(env: Env, profile: string, ended: "finished" | "failed" = "finished") {
  const index = env.canvas.started.findIndex((started) => started.profile === profile);
  const text = ended === "finished" ? answer(profile, env.canvas.started[index]!.prompt) : null;
  await env.host.replied!({ id: `conversation-fixer-${index + 1}`, profile }, { text, ended }, env.context);
}

const inFlight = (canvas: FakeCanvas<Review>) => (canvas.storage.get(IN_FLIGHT_KEY) ?? {}) as Record<string, { gaveUp?: true; reply?: unknown }>;

describe("the host: a seat the limit gave up on", () => {
  test("fails with the timeout, its conversation stays on record, and a reply that comes later is kept", async () => {
    const env = boot();
    const { id, beta, betaPrompt } = await betaTimesOut(env);
    const review = env.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.rounds).toBe(0);
    expect(review.reviewers[1]).toMatchObject({ status: "failed", problem: "Its turn took longer than 15 minutes" });
    expect(inFlight(env.canvas)[beta]).toMatchObject({ gaveUp: true });

    await env.host.replied!({ id: beta, profile: "beta" }, { text: answer("beta", betaPrompt), ended: "finished" }, env.context);
    expect(inFlight(env.canvas)[beta]!.reply).toBeDefined();
  });

  test("gives up after the turn limit the conversation's profile sets, else after 15 minutes", async () => {
    const canvas = new FakeCanvas<Review>();
    canvas.settings[TURN_LIMIT_SETTING] = "30";
    const env = boot(canvas);
    const startedAt = env.clock.time;
    const { id } = await betaTimesOut(env);
    const beta = env.canvas.item(id).data.reviewers[1]!;
    expect(beta.problem).toBe("Its turn took longer than 30 minutes");
    expect(beta.endedAt! - startedAt).toBeGreaterThanOrEqual(30 * 60_000);
    expect(turnLimitOf({ profileSetting: () => null })).toBe(15 * 60_000);
    expect(turnLimitOf({ profileSetting: () => "soon" })).toBe(15 * 60_000);
  });

  test("its late reply is told once to the review's conversation, naming its seat, for the user to fetch", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta", "profile:gamma"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    await drive(env, (profile) => profile !== "gamma");
    const review = env.canvas.item(id).data;
    expect(review.reviewers.map((reviewer) => reviewer.status)).toEqual(["failed", "failed", "completed"]);
    const before = env.canvas.prompts.length;

    await lateReplyOf(env, "beta");
    expect(env.canvas.prompts.slice(before)).toEqual([
      `Spectra Council review ${review.id}: ${review.reviewers[1]!.label}'s reply came in after its turn had timed out. The user can take it into the review with "Fetch its reply" on the canvas. Tell the user in one line, without calling any council tool.`,
    ]);
    expect(env.canvas.promptOptions.at(-1)).toEqual({ afterTurn: true });
  });

  test("a late reply heard through a context aimed at another conversation is kept and logged, not told; its chair still hears it once", async () => {
    const env = boot();
    const { beta } = await betaTimesOut(env);
    const before = env.canvas.prompts.length;
    const logged: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const misaimed = { ...env.context, conversationId: "conversation-other" };
      await env.host.replied!({ id: beta, profile: "beta" }, { text: answer("beta", env.canvas.started[1]!.prompt), ended: "finished" }, misaimed);
    } finally {
      console.error = real;
    }
    expect(logged.join("\n")).toContain("conversation-other");
    expect(inFlight(env.canvas)[beta]!.reply).toBeDefined();
    expect(env.canvas.prompts).toHaveLength(before);
    await lateReplyOf(env, "beta");
    expect(env.canvas.prompts).toHaveLength(before + 1);
  });

  test("its late reply is told once after a restart too, off the re-read gaveUp record", async () => {
    const env = boot();
    const { id, beta, betaPrompt } = await betaTimesOut(env);
    // The record survives the way real storage does it: as plain JSON, sharing no object identity with this process.
    env.canvas.storage.set(IN_FLIGHT_KEY, JSON.parse(JSON.stringify(env.canvas.storage.get(IN_FLIGHT_KEY))));
    const second = boot(env.canvas);
    const review = env.canvas.item(id).data;
    const before = env.canvas.prompts.length;
    await second.host.replied!({ id: beta, profile: "beta" }, { text: answer("beta", betaPrompt), ended: "finished" }, second.context);
    const told = env.canvas.prompts.slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`Spectra Council review ${review.id}: ${review.reviewers[1]!.label}'s reply came in after its turn had timed out`);
    expect(inFlight(env.canvas)[beta]!.reply).toBeDefined();
  });

  test("a late reply that ended badly is kept, but tells no one", async () => {
    const env = boot();
    const { beta } = await betaTimesOut(env);
    const before = env.canvas.prompts.length;
    await lateReplyOf(env, "beta", "failed");
    expect(inFlight(env.canvas)[beta]!.reply).toBeDefined();
    expect(env.canvas.prompts).toHaveLength(before);
  });

  test("a late reply that comes while the council deliberates is told to fetch once the review reaches its verdict", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta", "profile:gamma"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    const holdBeta = (profile: string) => profile === "beta";
    const done = await drive(env, holdBeta, new Set(), () => env.canvas.item(id).data.phase === "deliberation");
    const before = env.canvas.prompts.length;

    await lateReplyOf(env, "beta");
    const label = env.canvas.item(id).data.reviewers[1]!.label;
    expect(env.canvas.prompts.slice(before)).toEqual([
      expect.stringContaining(`"Fetch its reply" on the canvas once the review reaches its verdict; if it never gets there, the reply stays only in ${label}'s own conversation.`),
    ]);
    await drive(env, holdBeta, done);
    expect(env.canvas.item(id).data.phase).toBe("complete");
  });

  test("a late reply that lands while a restart has the review interrupted is told once, to take in after the resume", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta", "profile:gamma"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    await drive(env, (profile) => profile === "beta", new Set(), () => env.canvas.item(id).data.phase === "deliberation");
    // Mirador restarted mid-run: a new host finds the stored run with no session of its own and reads it as interrupted.
    const second = boot(env.canvas);
    const index = env.canvas.started.findIndex((started) => started.profile === "beta");
    const beta = `conversation-fixer-${index + 1}`;
    const before = env.canvas.prompts.length;
    await second.host.replied!({ id: beta, profile: "beta" }, { text: answer("beta", env.canvas.started[index]!.prompt), ended: "finished" }, second.context);
    const told = env.canvas.prompts.slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('"Fetch its reply" on the canvas once the user resumes it (Mirador restarted while it ran), while the reviewers review or once the review is complete.');
    expect(inFlight(env.canvas)[beta]!.reply).toBeDefined();
    expect(env.canvas.item(id).data.phase).toBe("deliberation");
  });

  test("its kept reply, fetched, reopens the review: grouped, deliberated and concluded as a run", async () => {
    const env = boot();
    const { id, done, beta, betaPrompt } = await betaTimesOut(env);
    await env.host.replied!({ id: beta, profile: "beta" }, { text: answer("beta", betaPrompt), ended: "finished" }, env.context);
    done.add(1);
    const before = env.canvas.started.length;

    expect(await env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context)).toBeNull();
    expect(env.canvas.item(id).data.phase).not.toBe("complete");
    await drive(env, () => false, done);
    const review = env.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.rounds).toBe(review.deliberationRounds);
    expect(review.reviewers.map((each) => each.status)).toEqual(["completed", "completed"]);
    expect(review.findings.map((each) => [each.title, each.status])).toEqual([
      ["alpha finding", "confirmed"],
      ["beta finding", "confirmed"],
    ]);
    expect(review.verdict!.summary).not.toContain("failed");
    // Grouping, two rounds of two and the proposals ran in new conversations; beta's review didn't run again.
    expect(env.canvas.started.slice(before).filter((each) => each.prompt === betaPrompt)).toHaveLength(0);
    expect(env.canvas.started.length).toBeGreaterThan(before);
    expect(inFlight(env.canvas)[beta]).toBeUndefined();
  });

  test("after a restart, the reply comes from Mirador's records, and council_begin goes on with the review", async () => {
    const first = boot();
    const { id, beta, betaPrompt } = await betaTimesOut(first);
    const second = boot(first.canvas);
    second.records.replies.set(beta, { text: answer("beta", betaPrompt), ended: "finished" });

    expect(await second.host.action!(second.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, second.context)).toEqual({ prompted: true });
    const waiting = second.canvas.item(id).data;
    expect(waiting).toMatchObject({ phase: "interrupted", interruptedPhase: "independent-review", verdict: null });
    expect(waiting.reviewers[1]!.status).toBe("completed");
    expect(second.canvas.prompts.at(-1)).toContain(`Call council_begin (review ${waiting.id})`);

    expect(await second.host.tools.council_begin!.run({}, second.context)).toContain("Resumed review");
    const done = new Set(first.canvas.started.map((_, index) => index));
    await drive(second, () => false, done);
    const review = second.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.rounds).toBeGreaterThan(0);
    expect(review.findings.map((each) => each.title)).toEqual(["alpha finding", "beta finding"]);
  });

  test("a kept reply that can't be used gives way to what Mirador's records hold now", async () => {
    const env = boot();
    const { id, beta, betaPrompt } = await betaTimesOut(env);
    // Mirador told the reply once, without its JSON; the user had the conversation answer again since.
    await env.host.replied!({ id: beta, profile: "beta" }, { text: "Looks fine.", ended: "finished" }, env.context);
    await expect(env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context)).rejects.toThrow("no valid JSON block");
    env.records.replies.set(beta, { text: answer("beta", betaPrompt), ended: "finished" });
    await env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context);
    // Taken in: the review reopened and deliberates.
    expect(env.canvas.item(id).data.findings.map((each) => each.title)).toEqual(["alpha finding", "beta finding"]);
    expect(env.canvas.item(id).data.phase).toBe("deliberation");
    await env.host.action!(env.canvas.item(id), { kind: "stop" }, env.context);
  });

  test("a retry of the timed-out seat starts a new conversation rather than taking over the one given up on", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    // A minute in, alpha answers without its JSON and is asked again; that repair is still at work when beta's turn
    // runs out, so the review is still in its independent review.
    await env.clock.settle();
    env.clock.time += 60_000;
    await env.host.replied!({ id: "conversation-fixer-1", profile: "alpha" }, { text: "No JSON here.", ended: "finished" }, env.context);
    await env.clock.step();
    expect(env.canvas.item(id).data.phase).toBe("independent-review");
    expect(env.canvas.item(id).data.reviewers[1]!.problem).toBe("Its turn took longer than 15 minutes");
    expect(inFlight(env.canvas)["conversation-fixer-2"]).toMatchObject({ gaveUp: true });
    await env.host.action!(env.canvas.item(id), { kind: "retry", reviewerId: "r2" }, env.context);
    await env.clock.settle();
    expect(env.canvas.started.map((each) => each.profile)).toEqual(["alpha", "beta", "alpha", "beta"]);
    await drive(env, () => false, new Set([0, 1]));
    const review = env.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.findings.map((each) => each.title)).toEqual(["alpha finding", "beta finding"]);
  });

  test("a stop leaves nothing on record; a timeout keeps the conversation", async () => {
    const env = boot();
    const { beta } = await betaTimesOut(env);
    expect(Object.keys(inFlight(env.canvas))).toEqual([beta]);
    const stopped = boot();
    await stopped.host.tools.council_open!.run({ target, agents: ["profile:alpha"] }, stopped.context);
    await stopped.host.action!(stopped.canvas.items[0]!, { kind: "start" }, stopped.context);
    await stopped.clock.settle();
    await stopped.host.action!(stopped.canvas.items[0]!, { kind: "stop" }, stopped.context);
    expect(inFlight(stopped.canvas)).toEqual({});
  });

  test("a reply not there yet, or with no JSON, changes nothing and says why", async () => {
    const env = boot();
    const { id, beta } = await betaTimesOut(env);
    const before = env.canvas.item(id).data;
    await expect(env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context)).rejects.toThrow(`Mirador has no record of its conversation ${beta}`);
    env.records.replies.set(beta, { text: null, ended: "running" });
    await expect(env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context)).rejects.toThrow("is still working");
    env.records.replies.set(beta, { text: "Looks fine to me.", ended: "finished" });
    await expect(env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r2" }, env.context)).rejects.toThrow("no valid JSON block");
    await expect(env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r1" }, env.context)).rejects.toThrow("hasn't failed");
    expect(env.canvas.item(id).data).toEqual(before);
    expect(inFlight(env.canvas)[beta]).toMatchObject({ gaveUp: true });
  });

  test("a deliberated review takes the reply's findings in late, without deliberating again", async () => {
    const env = boot();
    await env.host.tools.council_open!.run({ target, agents: ["profile:alpha", "profile:beta", "profile:gamma"], depth: "quick" }, env.context);
    const id = env.canvas.items[0]!.id;
    await env.host.action!(env.canvas.item(id), { kind: "start" }, env.context);
    // Gamma's review runs past its limit while alpha and beta deliberate without it.
    await drive(env, (profile) => profile === "gamma");
    const deliberated = env.canvas.item(id).data;
    expect(deliberated.phase).toBe("complete");
    expect(deliberated.rounds).toBeGreaterThan(0);
    const gamma = `conversation-fixer-${env.canvas.started.findIndex((each) => each.profile === "gamma") + 1}`;
    env.records.replies.set(gamma, { text: answer("gamma", ""), ended: "finished" });
    const before = env.canvas.started.length;

    expect(await env.host.action!(env.canvas.item(id), { kind: "fetch-reply", reviewerId: "r3" }, env.context)).toBeNull();
    const review = env.canvas.item(id).data;
    expect(review.phase).toBe("complete");
    expect(review.reviewers[2]!.status).toBe("completed");
    expect(review.findings.at(-1)).toMatchObject({ title: "gamma finding", status: "reported", late: true });
    expect(review.verdict!.summary).toContain("1 late");
    expect(review.agentHeardAt).toBeNull();
    expect(env.canvas.started).toHaveLength(before);
    expect(await env.host.tools.council_status!.run({}, env.context)).toContain("[medium, high confidence, reported, came in late after the verdict] gamma finding");
    // The agent hears of the review again with the user's next message.
    expect(env.host.note!(env.context)?.text).toContain(`review ${review.id} ended`);
  });
});
