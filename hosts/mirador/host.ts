/**
 * Spectra Council's canvas host, which Mirador runs in its own process. A review is a canvas item: the agent opens one
 * with council_open, the user sets it up and starts it in the view, and the engine's reviews go into the item's data,
 * which Mirador persists and sends to the view on every change.
 */
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AgentRunner } from "../../core/agent-runner.ts";
import { agentLabel, defaultSeats, isProfileAgent, profileName, runnerKindOf } from "../../core/agents.ts";
import { describeReview, outcomeOf } from "../../core/describe.ts";
import { ReviewSession, routeByAgent, systemClock, type AgentReply, type Clock, type Conversations } from "../../core/engine.ts";
import { fixerPrompt, parseFixerReport } from "../../core/fixer.ts";
import { acceptedFindings, handoffFile, handoffMarkdown } from "../../core/handoff.ts";
import { isFinished, isRunning, seatedReviewers, type Review } from "../../core/model.ts";
import { MockRunner, type FileLister } from "../../core/mock-runner.ts";
import { PROFILES } from "../../core/profiles.ts";
import { newReview, reduce, ReviewError, upgradeReview, type ReviewEvent } from "../../core/review.ts";
import { bySeverity } from "../../core/describe.ts";
import { depthSchema, problemsOf, profileIdSchema, SEATS, viewActionSchema, type Setup } from "../../core/schemas.ts";
import { listTargetFiles, targetKind } from "../../core/target-files.ts";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, CanvasTool, CanvasToolContext, ConversationReply, PluginItem } from "./api.ts";

export const ITEM_TYPE = "council";

/** Where the plugin's storage keeps the Mirador profiles seated before, most recent first. */
export const PROFILES_KEY = "seatedProfiles";
const REMEMBERED_PROFILES = 12;

/** The profile setting that names who fixes a review's accepted findings; none means this conversation's agent. */
export const FIXER_SETTING = "fixer";

const openInput = z.object({
  target: z
    .string()
    .min(1)
    .describe("The absolute path of what to review: the workspace folder you work in, unless the user names something narrower, such as one document or subfolder."),
  profile: profileIdSchema.optional().describe("What the council looks for; the user can change it in the setup. Default: general."),
  depth: depthSchema.optional().describe("How thorough the review is; default standard."),
  agents: z
    .array(z.string().min(1))
    .max(SEATS)
    .optional()
    .describe('Agents to seat, in order: a Mirador profile as "profile:" and its name (e.g. "profile:pi home"), or a mock persona (mock-claude, mock-codex, mock-gemini, mock-qwen); default: the first two mocks of four.'),
  instructions: z.string().optional().describe("What the user asked the reviewers to pay attention to, in their words."),
  title: z.string().min(1).optional().describe('The review\'s title, e.g. "Architecture review of the payment service".'),
});

const markFixedInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
  finding: z.string().min(1).describe('The finding you fixed, e.g. "F4".'),
  summary: z.string().min(1).describe("What you changed, in a sentence or two."),
  files: z.array(z.string().min(1)).default([]).describe("The files you changed, relative to the review's target."),
});

const delegateInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
});

const beginInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
});

const statusInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
});

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;

export interface HostOptions {
  clock?: Clock;
  listFiles?: FileLister;
  newId?: () => string;
  /** How often a running review's item is written at most; 0 writes every change. */
  throttleMs?: number;
  /** Writes a hand-off file, making its folder. */
  writeFile?: (path: string, text: string) => Promise<void>;
}

const writeWithFolder = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
};

export function createCouncilHost({
  clock = systemClock,
  listFiles = listTargetFiles,
  newId = () => crypto.randomUUID().slice(0, 8),
  throttleMs = 250,
  writeFile = writeWithFolder,
}: HostOptions = {}): CanvasHost<Review> {
  /** The reviews running in this process, by item id; one missing for a running review was cut short by a restart. */
  const sessions = new Map<string, ReviewSession>();
  /**
   * The latest tool call's context, by conversation: only a tool may start a conversation, and Mirador's tool context
   * stays usable after the tool returned, so reviewers' conversations start through it (docs/mirador-api.md). Lost on a
   * restart, when council_begin brings one back.
   */
  const toolContexts = new Map<string, CanvasToolContext<Review>>();
  /** Reviewer conversations waiting for their turn to end, by conversation id; `replied` settles them. */
  const pending = new Map<string, (reply: ConversationReply) => void>();

  /** Notes a profile the council seated, most recent first, for the setup to offer. */
  function rememberProfile(storage: CanvasPluginContext<Review>["storage"], name: string) {
    const known = storage.get(PROFILES_KEY);
    const before = Array.isArray(known) ? known.filter((each): each is string => typeof each === "string") : [];
    storage.set(PROFILES_KEY, [name, ...before.filter((each) => each.toLowerCase() !== name.toLowerCase())].slice(0, REMEMBERED_PROFILES));
  }

  /** Conversations on Mirador profiles, started for the reviews of the conversation `chairId`. */
  function conversationsOf(chairId: string, storage: CanvasPluginContext<Review>["storage"]): Conversations {
    return {
      ask: ({ profile, prompt, signal, onStart }) =>
        new Promise<AgentReply>((resolve, reject) => {
          const tool = toolContexts.get(chairId);
          if (!tool) return reject(new Error("Mirador was restarted since this review started; ask the agent to call council_begin."));
          if (signal.aborted) return reject(signal.reason);
          let id: string | null = null;
          const onAbort = () => {
            if (id) pending.delete(id);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          tool.startConversation({ profile, prompt }).then(
            (started) => {
              if (signal.aborted) return;
              id = started.id;
              rememberProfile(storage, started.profile);
              pending.set(started.id, ({ text, ended }) => {
                signal.removeEventListener("abort", onAbort);
                resolve({ conversationId: started.id, profile: started.profile, text, ended });
              });
              onStart?.(started.id);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        }),
    };
  }

  /** The conversation's reviews, each brought up to this version's format. */
  const councilItems = (context: CanvasPluginContext<Review>) =>
    context
      .items()
      .filter((item) => item.type === ITEM_TYPE)
      .map((item) => ({ ...item, data: upgradeReview(item.data) }));

  /** Writes a running review's item at most every throttleMs; the end of a review is written at once. */
  function writer(context: CanvasPluginContext<Review>, itemId: string) {
    let pending: Review | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!pending) return;
      const review = pending;
      pending = null;
      try {
        context.change(itemId, { data: review });
      } catch (error) {
        // The item is gone (its conversation was deleted): nothing will show the review any more.
        console.error(`spectra-council: review ${review.id} could not be written, stopping it:`, error);
        sessions.get(itemId)?.stop();
      }
    };
    return {
      write(review: Review) {
        pending = review;
        if (throttleMs === 0 || isFinished(review)) flush();
        else timer ??= setTimeout(flush, throttleMs);
      },
      flush,
    };
  }

  /**
   * A stored review as it stands: upgraded to this version's format, and, if it says it runs with no session here, marked
   * as cut short by a restart. Everything reads stored reviews through this.
   */
  const settled = (item: PluginItem<Review>): Review => {
    const review = upgradeReview(item.data);
    return isRunning(review) && !sessions.has(item.id) ? reduce(review, { type: "interrupted", at: clock.now() }) : review;
  };

  /** Applies an event, with a refused one's reason as a plain error for whoever asked. */
  function reduceOrSay(review: Review, event: ReviewEvent): Review {
    try {
      return reduce(review, event);
    } catch (error) {
      if (error instanceof ReviewError) throw new Error(error.message);
      throw error;
    }
  }

  function applyTo(item: PluginItem<Review>, context: CanvasPluginContext<Review>, event: ReviewEvent) {
    return context.change(item.id, { data: reduceOrSay(settled(item), event) });
  }

  /** The review a tool means: by id, else the conversation's newest. */
  function itemFor(context: CanvasPluginContext<Review>, wanted: string | undefined) {
    const items = councilItems(context);
    const item = wanted ? items.find(({ id, data }) => id === wanted || data.id === wanted) : items.at(-1);
    if (!item) throw new Error(wanted ? `No review ${wanted} in this conversation; its reviews are ${items.map(({ data }) => data.id).join(", ") || "none"}.` : "This conversation has no Spectra Council review; open one with council_open.");
    return item;
  }

  /** Runs a session's work (the review, or a verification round) in the background, writing the item as it goes. */
  function launch(item: PluginItem<Review>, context: CanvasPluginContext<Review>, review: Review, work: (session: ReviewSession) => Promise<Review>) {
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const out = writer(context, item.id);
    const mock = new MockRunner(listFiles, clock);
    const agents = new AgentRunner(conversationsOf(context.conversationId, context.storage), clock);
    const runner = routeByAgent((agent) => (isProfileAgent(agent) ? agents : mock));
    const session = new ReviewSession(review, { runner, clock, onChange: (next) => out.write(next) });
    sessions.set(item.id, session);
    // The engine ends each reviewer itself, failed or not; the work rejects only on a bug, which is logged.
    work(session)
      .catch((error) => console.error(`spectra-council: review ${review.id} failed:`, error))
      .finally(() => {
        out.flush();
        sessions.delete(item.id);
      });
  }

  /** The review of an item, if it can start now; otherwise says why not. */
  async function startable(item: PluginItem<Review>): Promise<Review> {
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const review = settled(item);
    if (review.phase !== "setup") throw new Error(`This review is ${review.phase}; ask the agent to open a new one.`);
    if (seatedReviewers(review).length === 0) throw new Error("Seat at least one reviewer before starting the review.");
    if (!isAbsolute(review.target) || (await targetKind(review.target)) === null) {
      throw new Error(`There is no file or folder at ${review.target}; give the absolute path of what to review.`);
    }
    return review;
  }

  /** The user's Start: runs the review, or, with profile seats and no tool context to start them from, asks the agent to. */
  async function start(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const review = await startable(item);
    const profiles = seatedReviewers(review).filter((reviewer) => isProfileAgent(reviewer.agent));
    if (profiles.length > 0 && !toolContexts.has(context.conversationId)) {
      const names = profiles.map((reviewer) => profileName(reviewer.agent)).join(", ");
      await context.prompt(`The user started Spectra Council review ${review.id}, which seats agents on Mirador profiles (${names}). Call council_begin (review ${review.id}) to start their conversations.`, { afterTurn: true });
      return null;
    }
    launch(item, context, review, (session) => session.run());
    return null;
  }

  /** The folder a review's hand-off goes in: the target's, or the folder of a target document. */
  async function handoffPath(review: Review) {
    const folder = (await targetKind(review.target)) === "file" ? dirname(review.target) : review.target;
    return join(folder, handoffFile(review));
  }

  /** Writes the hand-off of the accepted findings and records it; returns the review with it. */
  async function writeHandoff(item: PluginItem<Review>, context: CanvasPluginContext<Review>): Promise<Review> {
    const review = settled(item);
    const accepted = acceptedFindings(review).sort(bySeverity);
    if (accepted.length === 0) throw new Error("Accept at least one finding before writing the hand-off.");
    const path = await handoffPath(review);
    const event: ReviewEvent = { type: "handoff-written", at: clock.now(), path, findingIds: accepted.map(({ id }) => id) };
    const next = reduceOrSay(review, event);
    await writeFile(path, handoffMarkdown(next));
    return context.change(item.id, { data: next }).data;
  }

  /** Asks the conversation's agent to fix the accepted findings, writing the hand-off first if it is missing or stale. */
  async function requestFixes(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    let review = settled(item);
    const accepted = acceptedFindings(review).map(({ id }) => id);
    const current = review.handoff && review.handoff.findingIds.length === accepted.length && accepted.every((id) => review.handoff!.findingIds.includes(id));
    if (!current) review = await writeHandoff(item, context);
    const handoff = review.handoff!;
    const toFix = review.findings.filter((finding) => handoff.findingIds.includes(finding.id) && (!finding.fix || finding.fix.state === "handed-off" || finding.fix.state === "reopened"));
    if (toFix.length === 0) throw new Error("Every accepted finding is fixed already.");
    const ids = toFix.sort(bySeverity).map(({ id }) => id);
    const fixer = context.profileSetting(FIXER_SETTING) || null;
    context.change(item.id, { data: reduceOrSay(review, { type: "fix-requested", at: clock.now(), findingIds: ids, ...(fixer ? { profile: fixer } : {}) }) });
    if (fixer) {
      // Only a tool may start a conversation, so the agent is asked to call the one that does.
      await context.prompt(
        `The user handed ${ids.join(", ")} from Spectra Council review ${review.id} to the "${fixer}" profile to fix. Call council_delegate_fix (review ${review.id}) to start that conversation; don't fix them yourself.`,
        { afterTurn: true },
      );
      return null;
    }
    const reopened = toFix.filter((finding) => finding.fix?.state === "reopened").map(({ id }) => id);
    await context.prompt(
      [
        `Please fix these findings from Spectra Council review ${review.id}, most severe first: ${ids.join(", ")}.`,
        `The hand-off at ${handoff.path} has, for each one, the evidence, how the council reached its conclusion (including any dissent), and the proposed fix with how to verify it.`,
        reopened.length > 0 ? `${reopened.join(", ")} were fixed before but reopened by the council's re-check; council_status has what the reviewers found.` : "",
        "Fix only these findings. After each one, call council_mark_fixed with the finding id, what you changed, and the files.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      { afterTurn: true },
    );
    return null;
  }

  async function verify(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const review = settled(item);
    if (review.phase !== "complete") throw new Error(`Fixes are re-checked once the review is complete; it is ${review.phase}.`);
    if (!review.findings.some((finding) => finding.fix?.state === "fixed")) throw new Error("No finding has a fix to re-check yet.");
    launch(item, context, review, (session) => session.verify());
    return null;
  }

  /** Keeps each tool call's context, so reviewers' conversations can start from it later. */
  const keepingContext = (tools: Record<string, CanvasTool<Review>>): Record<string, CanvasTool<Review>> =>
    Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        {
          ...tool,
          run(input: unknown, context: CanvasToolContext<Review>) {
            toolContexts.set(context.conversationId, context);
            return tool.run(input, context);
          },
        },
      ]),
    );

  return {
    items: {
      [ITEM_TYPE]: {
        icon: "◎",
        placement: "page",
        opensWithRoom: { setting: "open" },
        outcome: (data: Review) => outcomeOf(upgradeReview(data)),
        listed: settled,
      },
    },
    tools: keepingContext({
      council_open: {
        description:
          "Open a Spectra Council review in the canvas: several AI reviewers examine a repository, folder or document independently and report structured findings with evidence, then deliberate over them in rounds (backing, challenging, conceding) until a synthesis settles each finding as agreed, confirmed, disputed or withdrawn; the user watches it all live. The target is the project you work in unless the user names something narrower; the user chooses the profile, depth and reviewers in the canvas and starts the review there. Seats are the user's Mirador profiles (real agents, each turn a new conversation on that profile) or deterministic mock personas for demos. Read a review's progress and findings with council_status.",
        input: jsonSchema(openInput),
        async run(input, context) {
          const parsed = openInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const { target, profile = "general", depth = "standard", agents, instructions = "", title } = parsed.data;
          if (!isAbsolute(target)) throw new Error(`The target must be an absolute path; got ${target}.`);
          if ((await targetKind(target)) === null) throw new Error(`There is no file or folder at ${target}.`);
          const seats = defaultSeats();
          agents?.forEach((agent, index) => (seats[index] = { agent, enabled: true }));
          if (agents) for (let index = agents.length; index < SEATS; index++) seats[index] = { ...seats[index]!, enabled: false };
          const setup: Setup = { target, profile, depth, seats, instructions };
          const review = newReview(newId(), setup, runnerKindOf(seats), clock.now());
          const item = context.publish({ type: ITEM_TYPE, title: title ?? `${PROFILES[profile].title} review · ${basename(target)}`, data: review });
          const seated = seatedReviewers(review).map((reviewer) => `${agentLabel(reviewer.agent)}${isProfileAgent(reviewer.agent) ? "" : " (mock)"}`);
          return `Opened Spectra Council review ${review.id} (item ${item.id}) in the canvas, in setup, seating ${seated.join(", ")}. The user picks the profile, depth and reviewers there and starts it; you hear when it ends, and council_status reads its findings.`;
        },
      },
      council_begin: {
        description:
          "Start a Spectra Council review the user pressed Start on, when it asks you to: starts a conversation for each seat on its Mirador profile. Only call it when the canvas asks; the review then runs on its own and you hear when it ends.",
        input: jsonSchema(beginInput),
        async run(input, context) {
          const parsed = beginInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const item = itemFor(context, parsed.data.review);
          const review = await startable(item);
          launch(item, context, review, (session) => session.run());
          const seated = seatedReviewers(review).map((reviewer) => agentLabel(reviewer.agent));
          return `Started review ${review.id} with ${seated.join(", ")}. It runs in the canvas on its own; you hear when it ends. There is nothing more for you to do now.`;
        },
      },
      council_status: {
        description: "Read a Spectra Council review: its phase, each reviewer's status, and every finding with its severity, confidence and evidence.",
        input: jsonSchema(statusInput),
        run(input, context) {
          const parsed = statusInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          return describeReview(settled(itemFor(context, parsed.data.review)));
        },
      },
      council_delegate_fix: {
        description:
          "Hand a Spectra Council review's findings that wait for a fixer profile (the user picked one and pressed Ask agent to fix) to that profile: starts a conversation on it with the hand-off. Its findings show as fixed when it reports back; you don't fix them yourself.",
        input: jsonSchema(delegateInput),
        async run(input, context) {
          const parsed = delegateInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const item = itemFor(context, parsed.data.review);
          const review = settled(item);
          if (!review.handoff) throw new Error(`Review ${review.id} has no hand-off yet; the user writes it in the canvas.`);
          const waiting = review.findings.filter((finding) => finding.fix?.fixer && finding.fix.fixer.conversationId === null && (finding.fix.state === "handed-off" || finding.fix.state === "reopened"));
          if (waiting.length === 0) throw new Error(`No finding of review ${review.id} waits for a fixer profile; the user picks one and presses Ask agent to fix.`);
          const profile = waiting[0]!.fix!.fixer!.profile;
          const ids = waiting.filter((finding) => finding.fix!.fixer!.profile === profile).sort(bySeverity).map(({ id }) => id);
          const started = await context.startConversation({ profile, prompt: fixerPrompt(review, ids, review.handoff.path) });
          applyTo(item, context, { type: "fix-delegated", at: clock.now(), findingIds: ids, profile: started.profile, conversationId: started.id });
          return `Started a conversation on ${started.profile} to fix ${ids.join(", ")} of review ${review.id}. The canvas shows each finding as fixed when it reports back; there is nothing more for you to do.`;
        },
      },
      council_mark_fixed: {
        description:
          "Report that you fixed a finding of a Spectra Council review that the user handed off to you: what you changed and in which files. The finding then shows as fixed in the canvas, and the user can have the council re-check it.",
        input: jsonSchema(markFixedInput),
        run(input, context) {
          const parsed = markFixedInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const { review: wanted, finding, summary, files } = parsed.data;
          const item = itemFor(context, wanted);
          const next = applyTo(item, context, { type: "fix-reported", at: clock.now(), findingId: finding, summary, files }).data;
          const open = next.findings.filter((each) => each.fix && (each.fix.state === "handed-off" || each.fix.state === "reopened")).map(({ id }) => id);
          return `Marked ${finding} fixed in review ${next.id}.${open.length > 0 ? ` Still to fix: ${open.join(", ")}.` : " Every handed-off finding is fixed; the user can have the council re-check them."}`;
        },
      },
    }),
    guidance: {
      instructions:
        "- council_open: when the user wants several AI agents to review a repository, folder or document (a Spectra Council review), open one in the canvas with the target's absolute path; the user sets it up and starts it there. When the canvas asks you to call council_begin, do. council_status reads its progress and findings; when the user hands findings off to you to fix, call council_mark_fixed after each fix, or council_delegate_fix when asked to hand them to another profile.",
    },
    async action(item, action, context) {
      const parsed = viewActionSchema.safeParse(action);
      if (!parsed.success) throw new Error(`Unknown action: ${problemsOf(parsed.error)}`);
      switch (parsed.data.kind) {
        case "configure":
          applyTo(item, context, { type: "configured", patch: parsed.data.patch });
          return null;
        case "start":
          return start(item, context);
        case "rule":
          applyTo(item, context, { type: "ruled", at: clock.now(), findingId: parsed.data.findingId, decision: parsed.data.decision, note: parsed.data.note });
          return null;
        case "handoff":
          await writeHandoff(item, context);
          return null;
        case "fix":
          return requestFixes(item, context);
        case "verify":
          return verify(item, context);
        case "fixer":
          return { profile: context.profileSetting(FIXER_SETTING) || null };
        case "profiles": {
          const known = context.storage.get(PROFILES_KEY);
          return { profiles: Array.isArray(known) ? known.filter((each) => typeof each === "string") : [] };
        }
        case "stop": {
          const session = sessions.get(item.id);
          if (session) session.stop();
          else applyTo(item, context, { type: "stopped", at: clock.now() });
          return null;
        }
      }
    },
    /**
     * A conversation the plugin started ended its turn: a reviewer's goes back to its runner; a fixer's shows what it
     * says it fixed as fixed, and the rest says why not.
     */
    replied(started, reply, context) {
      const reviewer = pending.get(started.id);
      if (reviewer) {
        pending.delete(started.id);
        reviewer(reply);
        return;
      }
      for (const item of councilItems(context)) {
        const review = item.data;
        const mine = review.findings.filter((finding) => finding.fix?.fixer?.conversationId === started.id);
        if (mine.length === 0) continue;
        const at = clock.now();
        const ids = new Set(mine.map(({ id }) => id));
        const report = reply.ended === "finished" ? parseFixerReport(reply.text) : null;
        let next = settled(item);
        const apply = (event: ReviewEvent) => {
          try {
            next = reduce(next, event);
          } catch (error) {
            console.error(`spectra-council: a fixer report for review ${review.id} was refused:`, error);
          }
        };
        const heard = new Set<string>();
        for (const fixed of report?.fixed ?? []) {
          if (!ids.has(fixed.finding)) continue;
          heard.add(fixed.finding);
          apply({ type: "fix-reported", at, findingId: fixed.finding, summary: fixed.summary, files: fixed.files });
        }
        for (const failed of report?.notFixed ?? []) {
          if (!ids.has(failed.finding) || heard.has(failed.finding)) continue;
          heard.add(failed.finding);
          apply({ type: "fix-failed", at, findingIds: [failed.finding], reason: `${started.profile}: ${failed.reason}` });
        }
        const silent = [...ids].filter((id) => !heard.has(id));
        if (silent.length > 0) {
          const reason =
            reply.ended !== "finished"
              ? `${started.profile}'s conversation ${reply.ended === "stopped" ? "was stopped" : "failed"} before it reported.`
              : report
                ? `${started.profile} didn't report on it.`
                : `${started.profile} ended without the JSON report; read its conversation to see what it changed.`;
          apply({ type: "fix-failed", at, findingIds: silent, reason });
        }
        context.change(item.id, { data: next });
      }
    },
    /** A review that ended since the agent last heard: it hears with the user's next message, once. */
    note(context) {
      const ended = councilItems(context).filter(({ data }) => data.startedAt !== null && isFinished(data) && data.agentHeardAt === null);
      if (ended.length === 0) return null;
      return {
        text: ended.map(({ data }) => `Spectra Council review ${data.id} ended (${data.phase}): ${outcomeOf(data)}. council_status reads its findings.`).join("\n"),
        heard: () => {
          for (const { id } of ended) {
            const latest = context.items().find((item) => item.id === id);
            if (latest) context.change(id, { data: reduce(upgradeReview(latest.data), { type: "agent-heard", at: clock.now() }) });
          }
        },
      };
    },
  };
}

export default createCouncilHost();
