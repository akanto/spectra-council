/**
 * Runs a seat with a real agent: each turn is a fresh conversation on the seat's Mirador profile. The prompt (see
 * agent-turns.ts) asks for the reply as a ```json block; the runner reads it and reports each item to the session, which
 * validates it. A turn that takes too long, ends badly or lacks the block fails the seat (or logs an error, for the
 * proposal and verification turns).
 */
import type { z } from "zod";
import { deliberationPrompt, proposalPrompt, reviewPrompt, verificationPrompt } from "./agent-turns.ts";
import { profileName } from "./agents.ts";
import { TURN_LIMIT_MS, type AgentReply, type Clock, type Conversations, type DeliberationJob, type ProposalJob, type Report, type ReviewerJob, type ReviewerRunner, type VerificationJob } from "./engine.ts";
import { lastJson } from "./replies.ts";
import { deliberationReplySchema, proposalReplySchema, reviewReplySchema, verificationReplySchema } from "./schemas.ts";

type Reporter = (report: Report) => void;

const NOTE_LENGTH = 240;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The prose before the last ```json block, trimmed and shortened; null when there is none. */
function proseBefore(text: string): string | null {
  const at = text.lastIndexOf("```json");
  const prose = (at >= 0 ? text.slice(0, at) : text).trim();
  if (!prose) return null;
  return prose.length > NOTE_LENGTH ? `${prose.slice(0, NOTE_LENGTH - 1).trimEnd()}…` : prose;
}

export class AgentRunner implements ReviewerRunner {
  readonly #conversations: Conversations;
  readonly #clock: Clock;
  readonly #limitMs: number;

  constructor(conversations: Conversations, clock: Clock, limitMs = TURN_LIMIT_MS) {
    this.#conversations = conversations;
    this.#clock = clock;
    this.#limitMs = limitMs;
  }

  run(job: ReviewerJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, "to review", reviewPrompt(job), reviewReplySchema, ({ findings }) => {
      for (const finding of findings) report({ type: "finding-reported", finding });
      return plural(findings.length, "finding");
    });
  }

  deliberate(job: DeliberationJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, `to argue round ${job.round}`, deliberationPrompt(job), deliberationReplySchema, ({ arguments: made }) => {
      for (const argument of made) report({ type: "argued", argument });
      return plural(made.length, "argument");
    });
  }

  propose(job: ProposalJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, "to propose fixes", proposalPrompt(job), proposalReplySchema, ({ proposals }) => {
      const kept = this.#only(proposals, "proposal", job.findingIds, report, (proposal) => report({ type: "fix-proposed", proposal }));
      return plural(kept, "proposal");
    });
  }

  verify(job: VerificationJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, "to re-check fixes", verificationPrompt(job), verificationReplySchema, ({ checks }) => {
      const kept = this.#only(checks, "check", job.findingIds, report, (check) => report({ type: "fix-checked", check }));
      return plural(kept, "check");
    });
  }

  /** Reports the items about the asked-for findings; the others are ignored with an error. Returns how many were kept. */
  #only(items: unknown[], noun: string, allowed: string[], report: Reporter, keep: (item: unknown) => void): number {
    let kept = 0;
    for (const item of items) {
      const findingId = typeof item === "object" && item !== null && "findingId" in item ? (item as { findingId: unknown }).findingId : undefined;
      if (typeof findingId === "string" && !allowed.includes(findingId)) {
        report({ type: "activity", kind: "error", text: `Ignored a ${noun} for ${findingId}: it wasn't asked for.` });
        continue;
      }
      keep(item);
      kept++;
    }
    return kept;
  }

  async #turn<S extends z.ZodType>(job: ReviewerJob, report: Reporter, signal: AbortSignal, what: string, prompt: string, schema: S, apply: (reply: z.infer<S>) => string) {
    const profile = profileName(job.reviewer.agent);
    report({ type: "activity", kind: "status", text: `Asking the ${profile} profile ${what}` });
    const reply = await this.#ask(profile, prompt, report, signal);
    if (reply.ended !== "finished") throw new Error(reply.ended === "failed" ? "Its conversation failed" : "Its conversation was stopped");
    const parsed = lastJson(reply.text, schema);
    if (parsed === null) throw new Error("Its reply ended without the JSON block");
    const prose = proseBefore(reply.text ?? "");
    if (prose) report({ type: "activity", kind: "note", text: prose });
    const summary = apply(parsed);
    report({ type: "activity", kind: "status", text: `Reported ${summary}` });
  }

  /** Asks with a time limit; the limit's timer and the ask are both cancelled once either settles. */
  async #ask(profile: string, prompt: string, report: Reporter, signal: AbortSignal): Promise<AgentReply> {
    const child = new AbortController();
    const link = () => child.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener("abort", link, { once: true });
    const ask = this.#conversations.ask({
      profile,
      prompt,
      signal: child.signal,
      onStart: (conversationId) => report({ type: "activity", kind: "tool", text: `Started conversation ${conversationId}` }),
      onModel: (model) => report({ type: "model-seen", model }),
    });
    // Rejects with the timeout, or with the signal's reason when the sleep is cancelled by an abort.
    const limit = this.#clock.sleep(this.#limitMs, child.signal).then((): never => {
      child.abort(new Error("timed out"));
      throw new Error(`Its turn took longer than ${Math.round(this.#limitMs / 60_000)} minutes`);
    });
    // Whichever loses the race must not leave an unhandled rejection behind.
    ask.catch(() => {});
    limit.catch(() => {});
    try {
      return await Promise.race([ask, limit]);
    } finally {
      signal.removeEventListener("abort", link);
      child.abort(new Error("done"));
    }
  }
}
