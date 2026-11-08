/**
 * Runs a seat with a real agent: each turn is a fresh conversation on the seat's Mirador profile. The prompt (see
 * agent-turns.ts) asks for the reply as a ```json block; the runner reads it and reports each item to the session, which
 * validates it. A turn that takes too long, ends badly or lacks the block fails the seat (or logs an error, for the
 * grouping, proposal and verification turns).
 */
import type { z } from "zod";
import { deliberationPrompt, groupingPrompt, proposalPrompt, repairPrompt, reviewPrompt, verificationPrompt } from "./agent-turns.ts";
import { profileName } from "./agents.ts";
import { TURN_LIMIT_MS, TurnTimeout, type AgentReply, type Clock, type Conversations, type DeliberationJob, type ProposalJob, type Report, type ReviewerJob, type ReviewerRunner, type VerificationJob } from "./engine.ts";
import { askingText, REVIEW_TURN, startedText } from "./late-replies.ts";
import { jsonProblem, lastJson } from "./replies.ts";
import type { ReplyFetched } from "./review.ts";
import { deliberationReplySchema, findingInputSchema, groupingReplySchema, problemsOf, proposalReplySchema, reviewReplySchema, verificationReplySchema, type FindingInput } from "./schemas.ts";

type Reporter = (report: Report) => void;

const NOTE_LENGTH = 240;
const PROBLEM_LENGTH = 160;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const LINK = /(?<!!)\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*<?([^()\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;

/** A short label for a link without text: the file's name and line, or the URL without its scheme. */
function labelOfUrl(url: string): string {
  const [path = "", anchor = ""] = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("#");
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const line = /^L(\d+)/.exec(anchor)?.[1];
  return line ? `${name}:${line}` : name;
}

/** Flattens Markdown links `[text](url)` to `text` (or a short label of the URL when the text is empty). Images stay. */
export function flattenLinks(text: string): string {
  return text.replace(LINK, (_all, label: string, url: string) => label.trim() || labelOfUrl(url));
}

/** The prose before the last ```json block, trimmed and shortened; null when there is none. */
function proseBefore(text: string): string | null {
  const at = text.lastIndexOf("```json");
  const prose = flattenLinks(at >= 0 ? text.slice(0, at) : text).trim();
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
    return this.#turn(job, report, signal, ["review"], REVIEW_TURN, reviewPrompt(job), reviewReplySchema, ({ findings }) => {
      for (const finding of findings) report({ type: "finding-reported", finding });
      return plural(findings.length, "finding");
    });
  }

  group(job: ReviewerJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, ["group"], "to group duplicate findings", groupingPrompt(job), groupingReplySchema, ({ groups }) => {
      for (const group of groups) report({ type: "duplicates-grouped", group });
      return plural(groups.length, "group");
    });
  }

  deliberate(job: DeliberationJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, ["deliberate", `round ${job.round}`], `to argue round ${job.round}`, deliberationPrompt(job), deliberationReplySchema, ({ arguments: made }) => {
      for (const argument of made) report({ type: "argued", argument });
      return plural(made.length, "argument");
    });
  }

  propose(job: ProposalJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, ["propose", ...[...job.findingIds].sort()], "to propose fixes", proposalPrompt(job), proposalReplySchema, ({ proposals }) => {
      const kept = this.#only(proposals, "proposal", job.findingIds, report, (proposal) => report({ type: "fix-proposed", proposal }));
      return plural(kept, "proposal");
    });
  }

  verify(job: VerificationJob, report: Reporter, signal: AbortSignal) {
    return this.#turn(job, report, signal, ["verify", `pass ${job.pass}`, ...[...job.findingIds].sort()], "to re-check fixes", verificationPrompt(job), verificationReplySchema, ({ checks }) => {
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

  /**
   * One turn: `task` names it apart from the reviewer's other turns (the kind, then its round or pass and findings), and
   * with the review and reviewer makes the turn's identity, which never holds a label or model name: those can change
   * while the turn runs, and a resumed review must ask the same turn again to take over its conversation.
   */
  async #turn<S extends z.ZodType>(job: ReviewerJob, report: Reporter, signal: AbortSignal, task: string[], what: string, prompt: string, schema: S, apply: (reply: z.infer<S>) => string) {
    const profile = profileName(job.reviewer.agent);
    // A repair also names the reply it repairs: after a restart the first ask is asked anew, and its new reply must not
    // take over the repair of the old one.
    const turn = (attempt: string, repairing?: string) => JSON.stringify([job.review.id, job.reviewer.id, ...task, attempt, ...(repairing === undefined ? [] : [repairing])]);
    report({ type: "activity", kind: "status", text: askingText(profile, what) });
    let reply = await this.#ask(profile, prompt, turn("ask"), report, signal);
    if (reply.ended !== "finished") throw new Error(reply.ended === "failed" ? "Its conversation failed" : "Its conversation was stopped");
    let parsed = lastJson(reply.text, schema);
    if (parsed === null) {
      // One more conversation with the reply and the problem, before the seat fails.
      const problem = jsonProblem(reply.text, schema);
      const short = problem.length > PROBLEM_LENGTH ? `${problem.slice(0, PROBLEM_LENGTH - 1).trimEnd()}…` : problem;
      report({ type: "activity", kind: "error", text: `Its reply had no valid JSON block (${short}); asking again` });
      const again = await this.#ask(profile, repairPrompt(prompt, reply.text ?? "", problem), turn("repair", reply.text ?? ""), report, signal);
      if (again.ended !== "finished") throw new Error(`Its reply had no valid JSON block (${short}), and the follow-up conversation ${again.ended === "failed" ? "failed" : "was stopped"}`);
      parsed = lastJson(again.text, schema);
      if (parsed === null) throw new Error(`Its reply had no valid JSON block, twice: ${jsonProblem(again.text, schema)}`);
      reply = again;
    }
    const prose = proseBefore(reply.text ?? "");
    if (prose) report({ type: "activity", kind: "note", text: prose });
    const summary = apply(parsed);
    report({ type: "activity", kind: "status", text: `Reported ${summary}` });
  }

  /** Asks with a time limit; the limit's timer and the ask are both cancelled once either settles. */
  async #ask(profile: string, prompt: string, turn: string, report: Reporter, signal: AbortSignal): Promise<AgentReply> {
    const child = new AbortController();
    const link = () => child.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener("abort", link, { once: true });
    const ask = this.#conversations.ask({
      profile,
      prompt,
      turn,
      signal: child.signal,
      onStart: (conversationId) => report({ type: "activity", kind: "tool", text: startedText(conversationId) }),
      onModel: (model) => report({ type: "model-seen", model }),
    });
    // Rejects with the timeout, or with the signal's reason when the sleep is cancelled by an abort. The ask is aborted
    // with the same error: a host's ask rejects with its signal's reason at once, and may win the race.
    const limit = this.#clock.sleep(this.#limitMs, child.signal).then((): never => {
      const timeout = new TurnTimeout(`Its turn took longer than ${Math.round(this.#limitMs / 60_000)} minutes`);
      child.abort(timeout);
      throw timeout;
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

/** How a conversation's latest turn ended, as a host reads it from its records: "running" while it hasn't. */
export interface LateReply {
  text: string | null;
  ended: AgentReply["ended"] | "running";
}

/**
 * The event that takes a failed seat's late reply to its own review into the review, read as `run` reads a reply: the
 * prose before its JSON block becomes a note, and each finding is checked as the session checks a reported one (a
 * malformed one is rejected, the rest count). Throws, saying why, when the reply can't be used: its turn hasn't ended,
 * ended badly, or left no valid JSON block.
 */
export function replyFetched(reviewerId: string, conversationId: string, reply: LateReply, at: number): ReplyFetched {
  if (reply.ended === "running") throw new Error(`Its conversation ${conversationId} is still working; fetch its reply once its turn has ended.`);
  if (reply.ended !== "finished") throw new Error(`Its conversation ${conversationId} ${reply.ended === "failed" ? "failed" : "was stopped"} before it replied.`);
  const parsed = lastJson(reply.text, reviewReplySchema);
  if (parsed === null) throw new Error(`Its reply in conversation ${conversationId} has no valid JSON block: ${jsonProblem(reply.text, reviewReplySchema)}.`);
  const findings: FindingInput[] = [];
  const rejected: string[] = [];
  for (const item of parsed.findings) {
    const finding = findingInputSchema.safeParse(item);
    if (finding.success) findings.push(finding.data);
    else rejected.push(problemsOf(finding.error));
  }
  return { type: "reply-fetched", reviewerId, at, conversationId, note: proseBefore(reply.text ?? ""), findings, rejected };
}
