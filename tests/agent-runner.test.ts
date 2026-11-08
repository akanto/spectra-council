import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../core/agent-runner.ts";
import { deliberationPrompt, proposalPrompt, reviewPrompt, verificationPrompt } from "../core/agent-turns.ts";
import { ReviewSession, TurnTimeout, type AgentReply, type Conversations } from "../core/engine.ts";
import { isStanding, type Review } from "../core/model.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce } from "../core/review.ts";
import { FakeClock } from "./support.ts";

type Handler = (profile: string, prompt: string, call: number, signal: AbortSignal) => Promise<Partial<AgentReply> & { text: string | null }> | (Partial<AgentReply> & { text: string | null });

/** Conversations whose replies a test scripts per profile; records every prompt. */
class FakeConversations implements Conversations {
  prompts: { profile: string; prompt: string; turn?: string }[] = [];
  private calls = new Map<string, number>();
  constructor(private handler: Handler) {}
  async ask({ profile, prompt, turn, signal, onStart }: Parameters<Conversations["ask"]>[0]): Promise<AgentReply> {
    this.prompts.push({ profile, prompt, turn });
    const call = this.calls.get(profile) ?? 0;
    this.calls.set(profile, call + 1);
    const conversationId = `c-${profile}-${call}`;
    onStart?.(conversationId);
    const reply = await this.handler(profile, prompt, call, signal);
    return { conversationId, profile, ended: "finished", ...reply };
  }
  promptsOf = (profile: string) => this.prompts.filter((each) => each.profile === profile).map((each) => each.prompt);
}

const json = (value: unknown, prose = "") => `${prose}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const evidence = [{ path: "src/a.ts", line: 3, quote: "x" }];
const finding = (title: string) => ({ title, summary: `${title} is wrong.`, severity: "high", confidence: "high", category: "correctness", evidence });

const newSeats = [
  { agent: "profile:alpha", enabled: true },
  { agent: "profile:beta", enabled: true },
  { agent: "mock-qwen", enabled: false },
  { agent: "mock-gemini", enabled: false },
];
const base = (instructions = "Mind the cache.") => newReview("rev", { target: "/work/repo", profile: "code", depth: "standard", instructions, seats: newSeats }, "mirador", 0);

const isDeliberation = (prompt: string) => prompt.includes("deliberation round");
const isProposal = (prompt: string) => prompt.includes("draft one fix proposal");

/** alpha reports F1, F2; beta reports F3; alpha challenges F3 in round 1, beta answers in round 2. */
const council: Handler = (profile, prompt) => {
  if (isProposal(prompt)) {
    const ids = [...prompt.matchAll(/^(F\d+) reported/gm)].map((match) => match[1]!);
    return {
      text: json({
        proposals: [
          ...ids.map((findingId) => ({ findingId, summary: `Fix ${findingId}`, steps: ["do it"], files: ["src/a.ts"], verification: "run tests" })),
          { findingId: "F9", summary: "stray", steps: ["x"], verification: "y" },
        ],
      }),
    };
  }
  if (isDeliberation(prompt)) {
    if (profile === "alpha" && prompt.includes("round 1 of")) {
      return { text: json({ arguments: [{ findingId: "F3", stance: "challenges", confidence: "high", text: "Not reachable.", evidence }] }, "Checked beta's claim.") };
    }
    if (profile === "beta" && prompt.includes("round 2 of")) {
      return { text: json({ arguments: [{ findingId: "F3", stance: "supports", confidence: "high", text: "It is reachable.", evidence, replyTo: "A1" }] }) };
    }
    return { text: json({ arguments: [] }) };
  }
  return { text: profile === "alpha" ? json({ findings: [finding("One"), finding("Two")] }, "Read the code.") : json({ findings: [finding("Three")] }) };
};

async function play(conversations: FakeConversations, review = base()) {
  const clock = new FakeClock();
  const session = new ReviewSession(review, { runner: new AgentRunner(conversations, clock), clock, onChange: () => {} });
  const done = session.run();
  await clock.runAll();
  return { review: await done, clock, session };
}

describe("AgentRunner in a whole review", () => {
  test("two profile seats review, argue, get a verdict and propose fixes", async () => {
    const conversations = new FakeConversations(council);
    const { review } = await play(conversations);
    expect(review.phase).toBe("complete");
    expect(review.findings.map((each) => [each.id, each.reviewerId])).toEqual([["F1", "r1"], ["F2", "r1"], ["F3", "r2"]]);
    expect(review.arguments).toHaveLength(2);
    expect(review.arguments[1]!.replyTo).toBe("A1");
    expect(review.findings.find((each) => each.id === "F3")!.status).toBe("disputed");
    expect(review.findings.filter((each) => each.id !== "F3").every((each) => each.status === "confirmed")).toBe(true);
    for (const each of review.findings.filter(isStanding)) expect(each.proposal?.summary).toBe(`Fix ${each.id}`);
    expect(review.verdict).not.toBeNull();
    const alpha = review.reviewers[0]!;
    const texts = alpha.activity.map((each) => `${each.kind}: ${each.text}`);
    expect(texts).toContain("status: Asking the alpha profile to review");
    expect(texts).toContain("tool: Started conversation c-alpha-0");
    expect(texts).toContain("note: Read the code.");
    expect(texts).toContain("status: Reported 2 findings");
    expect(texts.some((text) => text.startsWith("error: Ignored a proposal for F9"))).toBe(true);
    expect(texts).toContain("status: Asking the alpha profile to propose fixes");
    expect(review.reviewers[1]!.activity.map((each) => each.text)).toContain("Asking the beta profile to argue round 2");
  });

  test("prompts carry the target, rules, brief and instructions; deliberation lists the other seat's findings and arguments", async () => {
    const conversations = new FakeConversations(council);
    await play(conversations);
    const first = conversations.promptsOf("alpha")[0]!;
    expect(first).toContain("/work/repo");
    expect(first).toContain("don't change any file");
    expect(first).toContain(PROFILES.code.brief);
    expect(first).toContain("Mind the cache.");
    expect(first).toContain("End your final message with one ```json block");
    const betaRound2 = conversations.promptsOf("beta")[2]!;
    expect(betaRound2).toContain("round 2 of 3");
    expect(betaRound2).toContain("F1 reported by r1");
    expect(betaRound2).toContain("THIS IS YOUR OWN FINDING");
    expect(betaRound2).toContain("A1 [round 1] r1 on F3, challenges");
    expect(betaRound2).toContain("Not reachable.");
  });

  test("empty instructions leave no instructions section", () => {
    const review = base("  ");
    const job = { review, reviewer: review.reviewers[0]!, profile: PROFILES.code };
    expect(reviewPrompt(job)).not.toContain("The user's instructions");
  });
});

describe("AgentRunner failures", () => {
  const failing = (profile: string, reply: Awaited<ReturnType<Handler>>): Handler => (who, prompt, call, signal) => (who === profile && !isDeliberation(prompt) ? reply : council(who, prompt, call, signal));

  test("a reply without JSON twice fails that seat; the other goes on", async () => {
    const conversations = new FakeConversations(failing("beta", { text: "I looked and found nothing." }));
    const { review } = await play(conversations);
    expect(review.reviewers[1]!.status).toBe("failed");
    expect(review.reviewers[1]!.problem).toBe("Its reply had no valid JSON block, twice: no fenced ```json block");
    expect(conversations.promptsOf("beta").filter((prompt) => prompt.includes("could not be read"))).toHaveLength(1);
    expect(review.reviewers[0]!.status).toBe("completed");
    expect(review.phase).toBe("complete");
  });

  test("a reply without JSON is asked about once more, and the follow-up's block counts", async () => {
    const first = "I looked and found one thing.";
    const handler: Handler = (who, prompt, call, signal) => {
      if (who === "beta" && prompt.includes("could not be read")) return { text: json({ findings: [finding("Three")] }, "Here it is.") };
      return failing("beta", { text: first })(who, prompt, call, signal);
    };
    const conversations = new FakeConversations(handler);
    const { review } = await play(conversations);
    expect(review.reviewers[1]!.status).toBe("completed");
    expect(review.findings.filter((each) => each.reviewerId === "r2")).toHaveLength(1);
    const followUp = conversations.promptsOf("beta").find((prompt) => prompt.includes("could not be read"))!;
    expect(followUp).toContain("no fenced ```json block");
    expect(followUp).toContain(first);
    expect(followUp).toContain("End your final message with one ```json block");
    const texts = review.reviewers[1]!.activity.map((each) => `${each.kind}: ${each.text}`);
    expect(texts).toContain("error: Its reply had no valid JSON block (no fenced ```json block); asking again");
    expect(texts).toContain("status: Reported 1 finding");
  });

  test("a failed conversation fails the seat", async () => {
    const { review } = await play(new FakeConversations(failing("alpha", { text: null, ended: "failed" })));
    expect(review.reviewers[0]!.problem).toBe("Its conversation failed");
    expect(review.reviewers[1]!.status).toBe("completed");
  });

  test("a turn past the limit fails the seat and leaves no timer", async () => {
    const never: Handler = (who, prompt, call, signal) => (who === "beta" && !isDeliberation(prompt) ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) : council(who, prompt, call, signal));
    const { review, clock } = await play(new FakeConversations(never));
    expect(review.reviewers[1]!.status).toBe("failed");
    expect(review.reviewers[1]!.problem).toBe("Its turn took longer than 15 minutes");
    expect(clock.time).toBeGreaterThanOrEqual(1_000_000 + 15 * 60_000);
    expect(await clock.step()).toBe(false);
  });

  test("a host whose ask rejects at once on the limit's abort still shows the timeout, and hears it as one", async () => {
    // As Mirador's host does: the ask's promise rejects with the signal's reason the moment it aborts.
    const reasons: unknown[] = [];
    const hostLike: Conversations = {
      ask: ({ profile, prompt, signal, onStart }) => {
        if (profile === "beta" && !isDeliberation(prompt)) {
          onStart?.("c-beta");
          return new Promise((_, reject) => signal.addEventListener("abort", () => (reasons.push(signal.reason), reject(signal.reason)), { once: true }));
        }
        return Promise.resolve({ conversationId: `c-${profile}`, profile, ended: "finished" as const, ...(council(profile, prompt, 0, signal) as { text: string }) });
      },
    };
    const { review } = await play(hostLike as FakeConversations);
    expect(review.reviewers[1]!.problem).toBe("Its turn took longer than 15 minutes");
    expect(reasons[0]).toBeInstanceOf(TurnTimeout);
  });

  test("stopping the session aborts a pending ask", async () => {
    let aborted = false;
    const pending: Handler = (_who, _prompt, _call, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      );
    const clock = new FakeClock();
    const session = new ReviewSession(base(), { runner: new AgentRunner(new FakeConversations(pending), clock), clock, onChange: () => {} });
    const done = session.run();
    await clock.settle();
    session.stop();
    const review = await done;
    await clock.settle();
    expect(aborted).toBe(true);
    expect(review.phase).toBe("stopped");
    expect(await clock.step()).toBe(false);
  });

  test("a malformed finding shows as an error and the valid ones still count", async () => {
    const handler: Handler = (who, prompt, call, signal) =>
      who === "alpha" && !isDeliberation(prompt) && !isProposal(prompt) ? { text: json({ findings: [finding("Good"), { title: "Bad" }] }) } : council(who, prompt, call, signal);
    const { review } = await play(new FakeConversations(handler));
    expect(review.findings.filter((each) => each.reviewerId === "r1")).toHaveLength(1);
    expect(review.reviewers[0]!.activity.some((each) => each.kind === "error" && each.text.startsWith("Rejected a malformed finding"))).toBe(true);
    expect(review.reviewers[0]!.status).toBe("completed");
  });
});

describe("AgentRunner verify", () => {
  test("reports checks for the fixed findings only", async () => {
    const conversations = new FakeConversations(council);
    const { review: done } = await play(conversations);
    let current: Review = done;
    const ids = done.findings.filter(isStanding).map(({ id }) => id);
    for (const findingId of ids) current = reduce(current, { type: "ruled", at: 5_000_000, findingId, decision: "accepted", note: "" });
    current = reduce(current, { type: "handoff-written", at: 5_000_001, path: "/tmp/h.md", findingIds: ids });
    current = reduce(current, { type: "fix-requested", at: 5_000_002, findingIds: ids });
    for (const findingId of ids) current = reduce(current, { type: "fix-reported", at: 5_000_003, findingId, summary: `Guarded ${findingId}.`, files: ["src/a.ts"] });

    const verifier: Handler = (_who, prompt) => {
      expect(prompt).toContain("re-check pass 1");
      expect(prompt).toMatch(/Guarded F\d\./);
      const mine = [...prompt.matchAll(/^(F\d+) reported/gm)].map((match) => match[1]!);
      return { text: json({ checks: [...mine.map((findingId) => ({ findingId, outcome: "verified", text: "Looks fixed.", evidence })), { findingId: "F8", outcome: "verified", text: "stray" }] }) };
    };
    const clock = new FakeClock();
    const session = new ReviewSession(current, { runner: new AgentRunner(new FakeConversations(verifier), clock), clock, onChange: () => {} });
    const verified = session.verify();
    await clock.runAll();
    const after = await verified;
    expect(after.phase).toBe("complete");
    for (const findingId of ids) expect(after.findings.find((each) => each.id === findingId)!.fix?.checks.length).toBeGreaterThan(0);
    expect(after.reviewers.some((reviewer) => reviewer.activity.some((each) => each.text.startsWith("Ignored a check for F8")))).toBe(true);
    // The pure prompt builders stand alone too.
    const job = { review: current, reviewer: current.reviewers[0]!, profile: PROFILES.code, findingIds: ids, pass: 1 };
    expect(verificationPrompt(job)).toContain("Guarded F1.");
    expect(proposalPrompt({ ...job, review: done })).toContain("minority report");
    expect(deliberationPrompt({ ...job, round: 1, rounds: 3 })).toContain("round 1 of 3");
  });
});

describe("AgentRunner turn identities", () => {
  const turnsOf = (conversations: FakeConversations) => conversations.prompts.map((each) => each.turn!);

  test("every turn of a review has its own identity: by reviewer, task, round and findings", async () => {
    const conversations = new FakeConversations(council);
    await play(conversations);
    const turns = turnsOf(conversations);
    expect(turns.every((turn) => typeof turn === "string")).toBe(true);
    expect(new Set(turns).size).toBe(turns.length);
    const parsed = turns.map((turn) => JSON.parse(turn) as string[]);
    expect(parsed).toContainEqual(["rev", "r1", "review", "ask"]);
    expect(parsed).toContainEqual(["rev", "r2", "review", "ask"]);
    expect(parsed).toContainEqual(["rev", "r1", "deliberate", "round 1", "ask"]);
    expect(parsed).toContainEqual(["rev", "r1", "deliberate", "round 2", "ask"]);
    expect(parsed).toContainEqual(["rev", "r2", "deliberate", "round 1", "ask"]);
    expect(parsed.some((turn) => turn[2] === "propose" && turn.includes("F1"))).toBe(true);
  });

  test("the JSON repair is a turn of its own", async () => {
    const handler: Handler = (who, prompt, call, signal) => (who === "beta" && !isDeliberation(prompt) && !isProposal(prompt) ? { text: "Nothing to report." } : council(who, prompt, call, signal));
    const conversations = new FakeConversations(handler);
    await play(conversations);
    const beta = conversations.prompts.filter((each) => each.profile === "beta" && !isDeliberation(each.prompt)).map((each) => JSON.parse(each.turn!));
    expect(beta).toEqual([
      ["rev", "r2", "review", "ask"],
      ["rev", "r2", "review", "repair", "Nothing to report."],
    ]);
  });

  test("a turn's identity holds no label or model: a relabelled reviewer asks the same turn", async () => {
    const review = base();
    const relabelled = reduce(review, { type: "model-seen", reviewerId: "r1", model: { name: "Actual Model", effort: null } });
    expect(relabelled.reviewers[0]!.label).not.toBe(review.reviewers[0]!.label);
    const ask = async (on: Review) => {
      const conversations = new FakeConversations(council);
      await new AgentRunner(conversations, new FakeClock()).run({ review: on, reviewer: on.reviewers[0]!, profile: PROFILES.code }, () => {}, new AbortController().signal);
      return conversations.prompts[0]!;
    };
    const [before, after] = [await ask(review), await ask(relabelled)];
    expect(after.prompt).not.toBe(before.prompt);
    expect(after.turn).toBe(before.turn!);
  });
});
