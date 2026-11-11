/**
 * Spectra Council's canvas host, which Mirador runs in its own process. A review is a canvas item: the agent opens one
 * with council_open, the user sets it up and starts it in the view, and the engine's reviews go into the item's data,
 * which Mirador persists and sends to the view on every change.
 */
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AgentRunner, replyFetched, type LateReply } from "../../core/agent-runner.ts";
import { promptTitle } from "../../core/agent-turns.ts";
import { knobsText } from "../../core/depth.ts";
import { checkersOf, uncheckableFixes } from "../../core/deliberation.ts";
import { choiceOf, choiceText, expectedModel, isProfileAgent, modelLabel, offered, profileAgent, profileName, runnerKindOf, type ProfileInfo } from "../../core/agents.ts";
import { describeReview, finishedPrompt, fixerFinishedPrompt, lateReplyPrompt, outcomeOf } from "../../core/describe.ts";
import { ReviewSession, routeByAgent, systemClock, TURN_LIMIT_MS, TurnTimeout, type AgentReply, type Clock, type Conversations, type ReviewerRunner } from "../../core/engine.ts";
import { fixerPrompt, parseFixerReport } from "../../core/fixer.ts";
import { acceptedFindings, digestOf, handoffFile, handoffMarkdown } from "../../core/handoff.ts";
import { lastTurnOf, whenFetchable, whyNoFetch } from "../../core/late-replies.ts";
import { isFinished, isResumable, isRunning, seatedReviewers, type Finding, type ModelInfo, type Review } from "../../core/model.ts";
import { MockRunner, type FileLister } from "../../core/mock-runner.ts";
import { PROFILES } from "../../core/profiles.ts";
import { awaitsFixRequest, newReview, reduce, reopensWith, ReviewError, upgradeReview, type ReviewEvent } from "../../core/review.ts";
import { bySeverity } from "../../core/describe.ts";
import { depthSchema, MAX_SEATS, maxFindingsSchema, problemsOf, profileIdSchema, roundsSchema, ruleInput, seatSchema, stopInput, ticketIdSchema, viewActionSchema, type Decision, type Setup } from "../../core/schemas.ts";
import { listTargetFiles, resolveTargetPath, targetKind } from "../../core/target-files.ts";
import { askFixerPrompt, askPrompt, ticketsPrompt, unticketed, waitingTickets } from "../../core/tickets.ts";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, CanvasTool, CanvasToolContext, ConversationReply, PluginItem } from "./api.ts";
import { miradorRecords, noRecords, type MiradorRecords } from "./records.ts";

export const ITEM_TYPE = "council";

/** Where the plugin's storage keeps the Mirador profiles seated before, most recent first. */
export const PROFILES_KEY = "seatedProfiles";
const REMEMBERED_PROFILES = 12;

/** How many of the user's profiles council_open seats when the agent names no reviewers. */
const DEFAULT_SEATS = 2;

/** The profile setting that names who fixes a review's accepted findings; none means this conversation's agent. */
export const FIXER_SETTING = "fixer";

/** The profile setting for how many minutes a reviewer's turn may take; none, or one that isn't a number, keeps `TURN_LIMIT_MS`. */
export const TURN_LIMIT_SETTING = "turn-limit";

export function turnLimitOf(context: Pick<CanvasPluginContext<unknown>, "profileSetting">): number {
  const minutes = Number(context.profileSetting(TURN_LIMIT_SETTING));
  return minutes > 0 ? minutes * 60_000 : TURN_LIMIT_MS;
}

/** Where the plugin's storage keeps the reviewer conversations in flight, by conversation id. */
export const IN_FLIGHT_KEY = "inFlight";
const IN_FLIGHT_DAYS = 1;

/**
 * A reviewer conversation started and not heard back from yet: for which review, in which chair's conversation, with
 * which ask (a hash of the profile and the turn's identity; of the profile and prompt when the ask named no turn, and
 * in records from before turns were named), and its reply if that came in while no review waited for it (after a
 * restart, or after its turn ran past the limit). Only the same review, resumed, takes one over, and never one the
 * limit gave up on: that one is kept only for the user to fetch its late reply.
 */
interface InFlight {
  chair: string;
  review: string;
  key: string;
  /** Set when `key` hashes the turn's identity rather than the prompt. */
  turn?: true;
  profile: string;
  at: number;
  reply?: ConversationReply;
  /** Set when the turn's limit gave up on it: its seat failed, and its reply is kept for a fetch (`fetch-reply`). */
  gaveUp?: true;
}

const askKey = (profile: string, prompt: string) => Bun.hash(`${profile}\u0000${prompt}`).toString(36);

const openInput = z.object({
  target: z
    .string()
    .min(1)
    .describe("The absolute path of what to review: the workspace folder you work in, unless the user names something narrower, such as one document or subfolder."),
  profile: profileIdSchema.optional().describe("What the council looks for; the user can change it in the setup. Default: general."),
  depth: depthSchema
    .optional()
    .describe("A preset for the two knobs below: quick (2 rounds, at most 3 findings per reviewer), standard (3 rounds, 6 findings) or deep (4 rounds, 10 findings); default standard."),
  rounds: roundsSchema.optional().describe("Deliberation rounds, 1 to 6; overrides the depth preset's. Only when the user asks for a number."),
  maxFindings: maxFindingsSchema.optional().describe("The most findings each reviewer reports, 1 to 20; overrides the depth preset's. Only when the user asks for a number."),
  agents: z
    .array(
      z.union([
        z.string().min(1),
        seatSchema.pick({ agent: true, model: true, effort: true }).describe("A Mirador profile seat on a model or effort of its own, e.g. {\"agent\": \"profile:Home\", \"model\": \"opus\", \"effort\": \"high\"}."),
      ]),
    )
    .min(1)
    .max(MAX_SEATS)
    .optional()
    .describe(`The reviewers to seat, in order, 1 to ${MAX_SEATS}: a Mirador profile as "profile:" and its name (e.g. "profile:pi home"), or a mock persona (mock-claude, mock-codex, mock-gemini, mock-qwen, mock-glm). A profile seat runs on its profile's model and effort; only when the user names a model or effort for it, pass it as an object with model and effort. Seat mocks only when the user asks for a mock or demo review: their findings are illustrative, not an analysis. Default: the user's first two Mirador profiles, or none for the user to pick when no profile is known. The user can add and remove reviewers and choose their models in the setup.`),
  instructions: z.string().optional().describe("What the user asked the reviewers to pay attention to, in their words."),
  title: z.string().min(1).optional().describe('The review\'s title, e.g. "Architecture review of the payment service".'),
});

const markFixedInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
  finding: z.string().min(1).describe('The finding you fixed, e.g. "F4".'),
  summary: z.string().min(1).describe("What you changed, in a sentence or two."),
  files: z.array(z.string().min(1)).default([]).describe("The files you changed, relative to the review's target."),
});

const markTicketedInput = z.object({
  review: z.string().min(1).optional().describe("The review's id; default: this conversation's newest review."),
  finding: z.string().min(1).describe('The finding you filed an issue for, e.g. "F4".'),
  ticket: ticketIdSchema.describe('The beads issue\'s id, e.g. "myrepo-a1b".'),
});

const isFile = (path: string) => stat(path).then((it) => it.isFile(), () => false);

/**
 * The beads workspace a review's tickets go in: the nearest folder, from the target's folder up, whose `.beads` folder
 * is a workspace (it has bd's config.yaml or metadata.json; bd's own state in ~/.beads is not one); null when none is.
 */
export async function beadsWorkspace(folder: string, home = homedir()): Promise<string | null> {
  for (let at = folder; ; at = dirname(at)) {
    if (at !== home && ((await isFile(join(at, ".beads", "config.yaml"))) || (await isFile(join(at, ".beads", "metadata.json"))))) return at;
    if (dirname(at) === at) return null;
  }
}

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

const RULING_VERBS: Record<Decision, string> = { accepted: "Accepted", dismissed: "Dismissed", deferred: "Deferred" };

/** What the agent tells the user after a ruling it recorded: a finding no longer accepted keeps its beads issue, and one out of the fixes stays unfixed. */
function rulingConsequences(before: Finding, after: Finding | undefined): string[] {
  const consequences: string[] = [];
  const ticket = before.ticket?.id;
  if (ticket && before.ruling?.decision === "accepted" && after?.ruling?.decision !== "accepted") {
    consequences.push(`It has the beads issue ${ticket}: tell the user, and close or update it only if they want you to.`);
  }
  if (before.fix && !after?.fix) {
    const fixer = before.fix.fixer ? ` It was handed to the "${before.fix.fixer.profile}" profile, whose conversation can't hear this; its report on ${before.id} will be ignored.` : "";
    consequences.push(`It is out of the fixes now: don't fix it, and tell the user what you already changed for it, if anything.${fixer}`);
  }
  return consequences;
}

export interface HostOptions {
  clock?: Clock;
  listFiles?: FileLister;
  newId?: () => string;
  /** How often a running review's item is written at most; 0 writes every change. */
  throttleMs?: number;
  /** Writes a hand-off file, making its folder. */
  writeFile?: (path: string, text: string) => Promise<void>;
  /** Mirador's profiles and the models conversations run on; none by default, Mirador's database in the plugin. */
  records?: MiradorRecords;
  /** How long after a reviewer's conversation started its model is looked up, in turn, until one is found. */
  modelLookupMs?: number[];
  /**
   * A runner of the host's own for an agent, ahead of the mock and profile runners; undefined leaves the agent to them.
   * The promo video's build of the plugin plays scripted reviewers through it (video/lib/scripted-runner.ts).
   */
  runnerFor?: (agent: string) => ReviewerRunner | undefined;
}

/** A finding handed to a fixer profile whose conversation nobody started yet: council_delegate_fix's to start. */
const awaitsDelegation = (finding: Finding) => finding.fix?.state === "handed-off" && !!finding.fix.fixer && finding.fix.fixer.conversationId === null;

const writeWithFolder = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
};

/**
 * Tells a conversation something after its turn, without waiting: the prompt resolves only once the turn it starts ends,
 * which nothing here should wait for. Resolves whether the message got through: a conversation deleted meanwhile hears
 * nothing, which is logged and, for a verdict, given back to the note.
 */
async function promptAfterTurn(context: Pick<CanvasToolContext<Review>, "prompt" | "conversationId">, text: string, what: string): Promise<boolean> {
  try {
    await context.prompt(text, { afterTurn: true });
    return true;
  } catch (error) {
    console.error(`spectra-council: ${what}, but its conversation ${context.conversationId} couldn't be told:`, error);
    return false;
  }
}

export function createCouncilHost({
  clock = systemClock,
  listFiles = listTargetFiles,
  newId = () => crypto.randomUUID().slice(0, 8),
  throttleMs = 250,
  writeFile = writeWithFolder,
  records = noRecords,
  modelLookupMs = [1_500, 5_000, 15_000],
  runnerFor = () => undefined,
}: HostOptions = {}): CanvasHost<Review> {
  /** The reviews running in this process, by item id; one missing for a running review was cut short by a restart. */
  const sessions = new Map<string, ReviewSession>();
  /** The items a fixer conversation is being started for (council_delegate_fix awaits Mirador). */
  const delegating = new Set<string>();
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

  /** Conversations taken over after a restart in this process, so two asks don't take the same one. */
  const adopted = new Set<string>();

  /** The reviewer conversations started and not yet heard back from, kept across restarts (`InFlight`). */
  function inFlight(storage: CanvasPluginContext<Review>["storage"]): Record<string, InFlight> {
    const known = storage.get(IN_FLIGHT_KEY);
    return known && typeof known === "object" ? (known as Record<string, InFlight>) : {};
  }

  /** Changes the conversations in flight, dropping any older than a day. */
  function keepInFlight(storage: CanvasPluginContext<Review>["storage"], change: (all: Record<string, InFlight>) => void) {
    const all = { ...inFlight(storage) };
    change(all);
    const oldest = clock.now() - IN_FLIGHT_DAYS * 86_400_000;
    for (const [id, each] of Object.entries(all)) if (each.at < oldest) delete all[id];
    storage.set(IN_FLIGHT_KEY, Object.keys(all).length > 0 ? all : undefined);
  }

  /**
   * Conversations on Mirador profiles, started for the reviews of the conversation `chairId`. An ask the same as one
   * whose conversation a restart left running (same chair, review, profile and turn, as a resumed review asks again) takes
   * that conversation over, with its reply if it came in meanwhile, rather than starting a new one.
   */
  function conversationsOf(chairId: string, reviewId: string, storage: CanvasPluginContext<Review>["storage"]): Conversations {
    return {
      ask: ({ profile, model, effort, prompt, turn, signal, onStart, onModel }) =>
        new Promise<AgentReply>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          // The turn's identity rather than its prompt, which can change while the turn runs (a label follows the model).
          const key = askKey(profile, turn ?? prompt);
          const promptKey = askKey(profile, prompt);
          const sameAsk = (flight: InFlight) => (flight.turn ? turn !== undefined && flight.key === key : flight.key === promptKey);
          let id: string | null = null;
          let lookups: ReturnType<typeof setTimeout>[] = [];
          let seen = false;
          /** Stops a reviewer's conversation as the user's Stop would, through the chair's kept tool context; an older Mirador has no way to. */
          const stopReviewerConversation = (conversationId: string) => {
            const tool = toolContexts.get(chairId);
            void tool?.stopConversation?.(conversationId)?.catch((error: unknown) => console.error(`spectra-council: reviewer conversation ${conversationId} couldn't be stopped:`, error));
          };
          // The conversation's session reports its model a moment after it starts: look a few times, then at the end.
          const lookUp = () => {
            if (seen || !id) return;
            const model = records.modelOf(id);
            if (!model) return;
            seen = true;
            lookups.forEach(clearTimeout);
            onModel?.(model);
          };
          // A conversation given up on in this process is never taken over again: only a restart leaves one to take over.
          // One the turn's limit gave up on stays on record, so its late reply is kept when it comes, for a fetch.
          const onAbort = () => {
            lookups.forEach(clearTimeout);
            if (id) {
              pending.delete(id);
              adopted.delete(id);
              const gone = id;
              const timedOut = signal.reason instanceof TurnTimeout;
              keepInFlight(storage, (all) => {
                if (timedOut && all[gone]) all[gone] = { ...all[gone]!, gaveUp: true };
                else delete all[gone];
              });
              // A turn past its limit is kept running on purpose, so its late reply can be fetched.
              if (!timedOut) stopReviewerConversation(gone);
            }
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          const settle = (started: { id: string; profile: string }, { text, ended }: ConversationReply) => {
            signal.removeEventListener("abort", onAbort);
            lookUp();
            lookups.forEach(clearTimeout);
            keepInFlight(storage, (all) => delete all[started.id]);
            adopted.delete(started.id);
            resolve({ conversationId: started.id, profile: started.profile, text, ended });
          };
          const follow = (started: { id: string; profile: string }) => {
            id = started.id;
            lookups = modelLookupMs.map((ms) => setTimeout(lookUp, ms));
            pending.set(started.id, (reply) => settle(started, reply));
          };

          const left = Object.entries(inFlight(storage)).find(
            ([each, flight]) => flight.chair === chairId && flight.review === reviewId && !flight.gaveUp && sameAsk(flight) && !adopted.has(each) && !pending.has(each),
          );
          // A conversation that a crash cut short reports as failed: its work is redone in a new one.
          if (left && left[1].reply && left[1].reply.ended !== "finished") {
            const dead = left[0];
            keepInFlight(storage, (all) => delete all[dead]);
          } else if (left) {
            const [leftId, flight] = left;
            adopted.add(leftId);
            onStart?.(leftId);
            if (flight.reply) {
              id = leftId;
              return settle({ id: leftId, profile: flight.profile }, flight.reply);
            }
            return follow({ id: leftId, profile: flight.profile });
          }

          const tool = toolContexts.get(chairId);
          if (!tool) {
            signal.removeEventListener("abort", onAbort);
            return reject(new Error("Mirador was restarted since this review started; ask the agent to call council_begin."));
          }
          // A choice as the profile's agent offers it: Mirador takes an effort only by its exact value ("high", not "High").
          const info = model || effort ? records.profiles().find((each) => each.name.toLowerCase() === profile.toLowerCase()) : undefined;
          const chosen = {
            ...(model ? { model: offered(info?.models, model)?.value ?? model } : {}),
            ...(effort ? { effort: offered(info?.efforts, effort)?.value ?? effort } : {}),
          };
          tool.startConversation({ profile, prompt, title: promptTitle(prompt), ...chosen }).then(
            (started) => {
              // The ask gave up while this conversation was starting, before it could be followed: stop it all the same,
              // unless a turn past its limit gave up.
              if (signal.aborted) {
                if (!(signal.reason instanceof TurnTimeout)) stopReviewerConversation(started.id);
                return;
              }
              rememberProfile(storage, started.profile);
              keepInFlight(storage, (all) => (all[started.id] = { chair: chairId, review: reviewId, key, ...(turn !== undefined && { turn: true as const }), profile: started.profile, at: clock.now() }));
              follow(started);
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

  /** The profiles a seat can take: Mirador's, else the names the council seated before. */
  function profilesFor(storage: CanvasPluginContext<Review>["storage"]): ProfileInfo[] {
    const known = records.profiles();
    if (known.length > 0) return known;
    const remembered = storage.get(PROFILES_KEY);
    return (Array.isArray(remembered) ? remembered.filter((each): each is string => typeof each === "string") : []).map((name) => ({ name, harness: "", model: null }));
  }

  /**
   * A review in setup with each profile seat labelled by the model it most likely runs on: the one chosen for it, else
   * the one its profile's latest conversation ran on.
   */
  function identified(review: Review): Review {
    if (review.phase !== "setup" || !review.reviewers.some((reviewer) => isProfileAgent(reviewer.agent))) return review;
    const profiles = new Map<string, ProfileInfo>();
    for (const profile of records.profiles()) profiles.set(profile.name.toLowerCase(), profile);
    let next = review;
    for (const reviewer of review.reviewers) {
      if (!isProfileAgent(reviewer.agent)) continue;
      const model = expectedModel(profiles.get(profileName(reviewer.agent).toLowerCase()), reviewer.choice);
      if (model) next = reduce(next, { type: "model-seen", reviewerId: reviewer.id, model });
    }
    return next;
  }

  /** The item as it is now: an action's snapshot goes stale across an await, while the agent records fixes and tickets. */
  const fresh = (item: PluginItem<Review>, context: CanvasPluginContext<Review>) => context.items().find((each) => each.id === item.id) ?? item;

  /** The review as it stands: a running session's own (the stored one lags behind it), else the stored one. */
  const current = (item: PluginItem<Review>, context: CanvasPluginContext<Review>): Review => sessions.get(item.id)?.review ?? settled(fresh(item, context));

  /**
   * Applies an event to the review as it stands and returns the review after it. A running session owns its review and
   * writes it as it goes, so the event goes through the session; written to the item directly, its next write would drop
   * it. Every change from outside the engine comes through here.
   */
  function applyTo(item: PluginItem<Review>, context: CanvasPluginContext<Review>, event: ReviewEvent): Review {
    const session = sessions.get(item.id);
    if (!session) return context.change(item.id, { data: reduceOrSay(settled(fresh(item, context)), event) }).data;
    try {
      session.apply(event);
    } catch (error) {
      if (error instanceof ReviewError) throw new Error(error.message);
      throw error;
    }
    return session.review;
  }

  /** The review a tool means: by id, else the conversation's newest. */
  function itemFor(context: CanvasPluginContext<Review>, wanted: string | undefined) {
    const items = councilItems(context);
    const item = wanted ? items.find(({ id, data }) => id === wanted || data.id === wanted) : items.at(-1);
    if (!item) throw new Error(wanted ? `No review ${wanted} in this conversation; its reviews are ${items.map(({ data }) => data.id).join(", ") || "none"}.` : "This conversation has no Spectra Council review; open one with council_open.");
    return item;
  }

  /** A run came to a verdict of its own: not one the user stopped, which a stopped re-check leaves complete all the same. */
  const cameToItsVerdict = (session: ReviewSession, ended: Review) => ended.phase === "complete" && !session.stopped;

  /**
   * Tells the conversation a review belongs to that a run of it came to its verdict: the user hears it from that
   * conversation's own agent, rather than from a ping per reviewer's turn. It goes in the plugin's own voice, through the
   * tool context kept for that conversation, as a view action's would be the user's; with none since a restart, the ended
   * note tells the agent instead. The review is marked heard first, so the turn the prompt starts doesn't come with that
   * note repeating the verdict. A restart doesn't lose a verdict marked so: Mirador records the prompt as it takes it, in
   * the conversation's queue, which it keeps across a restart and sends from the next host (resumeAfterRestart in
   * Mirador's host/conversations.ts), or as the user message of the turn it starts — on a Codex conversation whose
   * session it held back, only once that session opens. Only a send that failed takes the mark back, and only its own,
   * not a later run's; there a rare duplicate is preferred over a verdict nobody ever hears.
   */
  function announceFinished(item: PluginItem<Review>, context: CanvasPluginContext<Review>, review: Review) {
    const tool = toolContexts.get(context.conversationId);
    if (!tool) return;
    const heardAt = clock.now();
    applyTo(item, context, { type: "agent-heard", at: heardAt });
    void promptAfterTurn(tool, finishedPrompt(review), `review ${review.id} is complete`).then((sent) => {
      if (sent) return;
      const latest = context.items().find((each) => each.id === item.id);
      if (latest && current(latest, context).agentHeardAt === heardAt) applyTo(latest, context, { type: "agent-unheard" });
    });
  }

  /** Tells a review's conversation that a reviewer's reply came in after its turn's limit gave up on it, when the user can fetch it. */
  function tellOfLateReply(reviewId: string, conversationId: string, context: CanvasActionContext<Review>) {
    const item = councilItems(context).find(({ data }) => data.id === reviewId);
    if (!item) return;
    const review = current(item, context);
    const reviewer = review.reviewers.find((each) => lastTurnOf(each)?.conversationId === conversationId);
    if (!reviewer) return;
    const fetchable = whenFetchable(review, reviewer);
    if (fetchable) void promptAfterTurn(context, lateReplyPrompt(review, reviewer, fetchable), `review ${review.id} has ${reviewer.label}'s late reply`);
  }

  /** Runs a session's work (the review, or a verification round) in the background, writing the item as it goes. */
  function launch(item: PluginItem<Review>, context: CanvasPluginContext<Review>, review: Review, work: (session: ReviewSession) => Promise<Review>) {
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const out = writer(context, item.id);
    const mock = new MockRunner(listFiles, clock);
    const agents = new AgentRunner(conversationsOf(context.conversationId, review.id, context.storage), clock, turnLimitOf(context));
    const runner = routeByAgent((agent) => runnerFor(agent) ?? (isProfileAgent(agent) ? agents : mock));
    const session = new ReviewSession(review, { runner, clock, onChange: (next) => out.write(next) });
    sessions.set(item.id, session);
    // The engine ends each reviewer itself, failed or not; the work rejects only on a bug, which is logged.
    work(session)
      .then((ended) => {
        if (cameToItsVerdict(session, ended)) announceFinished(item, context, ended);
      })
      .catch((error) => console.error(`spectra-council: review ${review.id} failed:`, error))
      .finally(() => {
        out.flush();
        sessions.delete(item.id);
        // Nothing of this review's left over from before a restart is wanted once it has gone on and ended, but for
        // the conversations the limit gave up on, whose late replies the user may still fetch.
        if (!isRunning(session.review)) keepInFlight(context.storage, (all) => {
          for (const [id, flight] of Object.entries(all)) if (flight.review === review.id && !pending.has(id) && !flight.gaveUp) delete all[id];
        });
      });
  }

  /**
   * The review of an item, if it can start now (in setup) or resume (cut short by a restart); otherwise says why not.
   */
  async function startable(item: PluginItem<Review>): Promise<Review> {
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const review = settled(item);
    if (hasFixedFinding(review)) return checkable(review);
    if (review.phase !== "setup" && !isResumable(review)) throw new Error(`This review is ${review.phase}; ask the agent to open a new one.`);
    if (seatedReviewers(review).length === 0) throw new Error("Seat at least one reviewer before starting the review.");
    if (!isAbsolute(review.target) || (await targetKind(review.target)) === null) {
      throw new Error(`There is no file or folder at ${review.target}; give the absolute path of what to review.`);
    }
    return review;
  }

  /** The review, if a reviewer is left to re-check each of its fixes; otherwise says which can't be. */
  function checkable(review: Review): Review {
    const stuck = uncheckableFixes(review).map((finding) => finding.id);
    if (stuck.length === 0) return review;
    const which = stuck.length === 1 ? `${stuck[0]}'s fix` : `the fixes of ${stuck.join(", ")}`;
    throw new Error(`No reviewer who completed the review is left to re-check ${which}: every reviewer failed or was removed. Check ${stuck.length === 1 ? "it" : "them"} yourself, or open a new review.`);
  }

  /** A complete review with a fixed finding is one whose fixes can be re-checked. */
  const hasFixedFinding = (review: Review) => review.phase === "complete" && review.findings.some((finding) => finding.fix?.state === "fixed");

  /** Runs a review in setup, resumes one a restart cut short, or re-checks the fixes of a complete one. */
  const begin = (item: PluginItem<Review>, context: CanvasPluginContext<Review>, review: Review) =>
    launch(item, context, review, (session) => (hasFixedFinding(review) ? session.verify() : review.phase === "setup" ? session.run() : session.resume()));

  /**
   * The user's Start or Resume: runs the review, or, with profile seats and no tool context to start them from, asks the
   * agent to.
   */
  async function start(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const review = await startable(item);
    const profiles = seatedReviewers(review).filter((reviewer) => isProfileAgent(reviewer.agent));
    if (profiles.length > 0 && !toolContexts.has(context.conversationId)) {
      const names = profiles.map((reviewer) => profileName(reviewer.agent)).join(", ");
      const what = review.phase === "setup" ? "started" : "resumed";
      await context.prompt(`The user ${what} Spectra Council review ${review.id}, which seats agents on Mirador profiles (${names}). Call council_begin (review ${review.id}) to start their conversations.`, { afterTurn: true });
      return { prompted: true };
    }
    begin(item, context, review);
    return null;
  }

  /** The folder a review's hand-off goes in: the target's, or the folder of a target document. */
  async function handoffPath(review: Review) {
    const folder = (await targetKind(review.target)) === "file" ? dirname(review.target) : review.target;
    return join(folder, handoffFile(review));
  }

  /** Writes the hand-off of the accepted findings and records it; returns the review with it. */
  async function writeHandoff(item: PluginItem<Review>, context: CanvasPluginContext<Review>): Promise<Review> {
    const review = current(item, context);
    const accepted = acceptedFindings(review).sort(bySeverity);
    if (accepted.length === 0) throw new Error("Accept at least one finding before writing the hand-off.");
    const path = await handoffPath(review);
    const event: ReviewEvent = { type: "handoff-written", at: clock.now(), path, findingIds: accepted.map(({ id }) => id) };
    const text = handoffMarkdown(reduceOrSay(review, event));
    await writeFile(path, text);
    // Recorded on the review as it is now: the agent may have reported a fix or a ticket while the file was written.
    return applyTo(item, context, { ...event, digest: digestOf(text) });
  }

  /** The review with a hand-off of exactly its accepted findings: the one written, or a new one if it is missing or stale. */
  async function currentHandoff(item: PluginItem<Review>, context: CanvasPluginContext<Review>): Promise<Review> {
    const review = current(item, context);
    const accepted = acceptedFindings(review).map(({ id }) => id);
    const sameFindings = review.handoff && review.handoff.findingIds.length === accepted.length && accepted.every((id) => review.handoff!.findingIds.includes(id));
    // The file is stale when its text would differ now: a fix report, a reopening, a changed ruling note, a new dismissal.
    const upToDate = sameFindings && review.handoff!.digest === digestOf(handoffMarkdown(review));
    return upToDate ? review : writeHandoff(item, context);
  }

  /** The folder a review's beads workspace is looked for from: the target's, or the folder of a target document. */
  async function beadsFor(review: Review) {
    return beadsWorkspace(dirname(await handoffPath(review)));
  }

  /** Asks the conversation's agent to file a beads issue for each accepted finding that has none yet. */
  async function requestTickets(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const workspace = await beadsFor(settled(item));
    if (!workspace) throw new Error(`There is no beads workspace (a .beads folder) at ${item.data.target} or above it; run bd init there to track the findings in beads.`);
    const review = await currentHandoff(item, context);
    // The findings with no ticket yet; else, asked again, those whose ticket the agent never reported.
    const fresher = unticketed(review);
    const ids = (fresher.length > 0 ? fresher : waitingTickets(review)).map(({ id }) => id);
    if (ids.length === 0) throw new Error("Every accepted finding that isn't fixed has a ticket already.");
    const next = applyTo(item, context, { type: "tickets-requested", at: clock.now(), findingIds: ids });
    await context.prompt(ticketsPrompt(next, ids, review.handoff!.path, workspace), { afterTurn: true });
    return null;
  }

  /**
   * Sends the user's own instruction about the accepted findings, with the hand-off, to the conversation's agent, or, to
   * the fixer profile: the agent is asked to start that conversation, since only a tool may.
   */
  async function ask(item: PluginItem<Review>, context: CanvasActionContext<Review>, text: string, toFixer: boolean) {
    const fixer = toFixer ? context.profileSetting(FIXER_SETTING) || null : null;
    if (toFixer && !fixer) throw new Error("No Spectra Council fixer profile is chosen for this conversation; pick one in the conversation header.");
    const review = await currentHandoff(item, context);
    const ids = acceptedFindings(review).map(({ id }) => id);
    const next = applyTo(item, context, { type: "asked", at: clock.now(), text, findingIds: ids, ...(fixer ? { profile: fixer } : {}) });
    if (fixer) {
      await context.prompt(
        `The user sent their own ask about the accepted findings of Spectra Council review ${next.id} to the "${fixer}" profile. Call council_delegate_fix (review ${next.id}) to start that conversation; don't do what it asks yourself.`,
        { afterTurn: true },
      );
      return null;
    }
    await context.prompt(askPrompt(next, text, review.handoff!.path), { afterTurn: true });
    return null;
  }

  /** Asks the conversation's agent to fix the accepted findings, writing the hand-off first if it is missing or stale. */
  async function requestFixes(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    await currentHandoff(item, context);
    // As it is now: a fixer may have reported, failed or been started while the hand-off was written.
    const review = current(item, context);
    const handoff = review.handoff!;
    const handed = review.findings.filter((finding) => handoff.findingIds.includes(finding.id));
    // Work already waiting for or with a fixer stays there: asking again would start a second fixer on it.
    const toFix = handed.filter(awaitsFixRequest);
    if (toFix.length === 0) {
      const pending = handed.filter((finding) => finding.fix?.state === "handed-off").map(({ id }) => id);
      if (pending.length > 0) {
        const these = pending.length === 1 ? "it" : "them";
        throw new Error(`Nothing new to fix: ${pending.join(", ")} ${pending.length === 1 ? "is" : "are"} with the fixer already. To hand ${these} over again, take ${these} out of the fixes and accept ${these} again.`);
      }
      throw new Error("Every accepted finding is fixed already.");
    }
    const ids = toFix.sort(bySeverity).map(({ id }) => id);
    const fixer = context.profileSetting(FIXER_SETTING) || null;
    applyTo(item, context, { type: "fix-requested", at: clock.now(), findingIds: ids, ...(fixer ? { profile: fixer } : {}) });
    if (fixer) {
      // Only a tool may start a conversation, so the agent is asked to call the one that does.
      await context.prompt(
        `The user handed ${ids.join(", ")} from Spectra Council review ${review.id} to the "${fixer}" profile to fix. Call council_delegate_fix (review ${review.id}) to start that conversation; don't fix them yourself.`,
        { afterTurn: true },
      );
      return null;
    }
    // Reopened before, even if a fixer has failed it since: the agent should know an earlier fix didn't hold.
    const reopened = toFix.filter((finding) => finding.fix?.checks.some((check) => check.outcome === "reopened")).map(({ id }) => id);
    await context.prompt(
      [
        `Please fix these findings from Spectra Council review ${review.id}, most severe first: ${ids.join(", ")}.`,
        `The hand-off at ${handoff.path} has, for each one, the evidence, how the council reached its conclusion (including any dissent), and the proposed fix with how to verify it.`,
        reopened.length > 0 ? `${reopened.join(", ")} were fixed before but reopened by the council's re-check; council_status has what the reviewers found.` : "",
        `Fix only these findings. After each one, call council_mark_fixed with review "${review.id}", the finding id, what you changed, and the files.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      { afterTurn: true },
    );
    return null;
  }

  /** Starts the fixer profile's conversation for the findings handed to it; says so, and whether an ask waits too. */
  async function delegateFixes(item: PluginItem<Review>, context: CanvasToolContext<Review>, review: Review, waiting: Finding[], askWaits: boolean): Promise<string> {
    const profile = waiting[0]!.fix!.fixer!.profile;
    const ids = waiting.filter((finding) => finding.fix!.fixer!.profile === profile).sort(bySeverity).map(({ id }) => id);
    let started: Awaited<ReturnType<typeof context.startConversation>>;
    try {
      const prompt = fixerPrompt(review, ids, review.handoff!.path);
      started = await context.startConversation({ profile, prompt, title: promptTitle(prompt) });
    } catch (error) {
      // Recorded as the fixer's failure, so asking again hands the work over anew (to the fixer chosen then).
      const reason = `Couldn't start a conversation on ${profile}: ${error instanceof Error ? error.message : String(error)}`;
      const unstarted = current(item, context).findings.filter((finding) => awaitsDelegation(finding) && ids.includes(finding.id)).map(({ id }) => id);
      if (unstarted.length > 0) applyTo(item, context, { type: "fix-failed", at: clock.now(), findingIds: unstarted, reason });
      throw error;
    }
    // The conversation is this one's to own, but only for findings still waiting for it: one taken out of the fixes
    // while it started isn't its work (the delegation lock keeps another council_delegate_fix from claiming any).
    const still = new Set(current(item, context).findings.filter((finding) => awaitsDelegation(finding) && finding.fix!.fixer!.profile === profile).map(({ id }) => id));
    const owned = ids.filter((id) => still.has(id));
    if (owned.length > 0) applyTo(item, context, { type: "fix-delegated", at: clock.now(), findingIds: owned, profile: started.profile, conversationId: started.id });
    const said = `Started a conversation on ${started.profile} to fix ${ids.join(", ")} of review ${review.id}. The canvas shows each finding as fixed when it reports back.`;
    const more = waiting.length > ids.length || askWaits;
    return more ? `${said} More waits for a fixer profile (${askWaits ? "the user's ask" : "findings for another profile"}): call council_delegate_fix (review ${review.id}) again.` : `${said} There is nothing more for you to do.`;
  }

  /**
   * A failed seat's late reply to its own review, from the conversation its activity names: the reply kept when Mirador
   * told it after the seat gave up, else what Mirador's records hold. Taken in as the seat's review: into the running
   * independent review; into a complete review that ended without a deliberation, which then goes on to one (through
   * council_begin when no tool context can start the reviewers' conversations); else, after the verdict, as late
   * findings. A reply that isn't there or usable yet changes nothing: the error says why.
   */
  async function fetchReply(item: PluginItem<Review>, context: CanvasActionContext<Review>, reviewerId: string) {
    const review = current(item, context);
    const reviewer = review.reviewers.find(({ id }) => id === reviewerId);
    if (!reviewer) throw new Error(`No reviewer ${reviewerId} sits at the council.`);
    const why = whyNoFetch(review, reviewer);
    if (why) throw new Error(why);
    const conversationId = lastTurnOf(reviewer)!.conversationId!;
    // The reply kept when Mirador told it; else, or when that one can't be used (Mirador tells it once, and the user may
    // have had the conversation answer again since), what Mirador's records hold now.
    const kept: LateReply | undefined = inFlight(context.storage)[conversationId]?.reply;
    let event: ReturnType<typeof replyFetched> | null = null;
    let problem: unknown = null;
    for (const read of [() => kept ?? null, () => records.replyOf(conversationId)]) {
      const reply = read();
      if (!reply) continue;
      try {
        event = replyFetched(reviewer.id, conversationId, reply, clock.now());
        break;
      } catch (error) {
        problem ??= error;
      }
    }
    if (!event) {
      if (problem === null) throw new Error(`Couldn't fetch ${reviewer.label}'s reply: Mirador has no record of its conversation ${conversationId}.`);
      throw new Error(`Couldn't take ${reviewer.label}'s reply: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
    const taken = () => keepInFlight(context.storage, (all) => delete all[conversationId]);
    if (sessions.has(item.id) || !reopensWith(review, event)) {
      applyTo(item, context, event);
      taken();
      return null;
    }
    taken();
    const profiles = seatedReviewers(review).filter((each) => isProfileAgent(each.agent));
    if (profiles.length > 0 && !toolContexts.has(context.conversationId)) {
      // No way to start the reviewers' conversations from here: the review waits where a restart would have left it, at
      // the end of its independent review, for council_begin to resume it.
      const waiting = [{ type: "reopened", at: event.at }, event, { type: "interrupted", at: event.at }].reduce<Review>((next, each) => reduceOrSay(next, each as ReviewEvent), review);
      context.change(item.id, { data: waiting });
      const names = [...new Set(profiles.map((each) => profileName(each.agent)))].join(", ");
      await context.prompt(
        `The user fetched ${reviewer.label}'s late reply into Spectra Council review ${review.id}, which can now be deliberated; it seats agents on Mirador profiles (${names}). Call council_begin (review ${review.id}) to start their conversations.`,
        { afterTurn: true },
      );
      return { prompted: true };
    }
    launch(item, context, review, (session) => session.reopen(event));
    return null;
  }

  /** Asks the agent to open a new review with an ended one's setup: only a tool may publish an item. */
  async function rerun(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const review = settled(item);
    if (!isFinished(review)) throw new Error(`This review is ${review.phase}; it can be run again once it has ended.`);
    const open = {
      target: review.target,
      profile: review.profile,
      ...(review.depth === "custom" ? {} : { depth: review.depth }),
      rounds: review.deliberationRounds,
      maxFindings: review.maxFindings,
      ...(seatedReviewers(review).length > 0 ? { agents: seatedReviewers(review).map((reviewer) => (reviewer.choice ? { agent: reviewer.agent, ...reviewer.choice } : reviewer.agent)) } : {}),
      ...(review.instructions ? { instructions: review.instructions } : {}),
      title: item.title,
    };
    await context.prompt(`The user wants to run Spectra Council review ${review.id} again. Call council_open with ${JSON.stringify(open)}; the user starts it in the canvas.`, { afterTurn: true });
    return null;
  }

  async function verify(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    const review = settled(item);
    if (review.phase !== "complete") throw new Error(`Fixes are re-checked once the review is complete; it is ${review.phase}.`);
    if (!review.findings.some((finding) => finding.fix?.state === "fixed")) throw new Error("No finding has a fix to re-check yet.");
    checkable(review);
    const checkers = new Map<string, string>();
    for (const finding of review.findings) {
      if (finding.fix?.state !== "fixed") continue;
      for (const reviewer of checkersOf(review, finding)) if (isProfileAgent(reviewer.agent)) checkers.set(reviewer.id, profileName(reviewer.agent));
    }
    if (checkers.size > 0 && !toolContexts.has(context.conversationId)) {
      const names = [...new Set(checkers.values())].join(", ");
      await context.prompt(`The user asked to re-check fixes in Spectra Council review ${review.id}, which seats agents on Mirador profiles (${names}). Call council_begin (review ${review.id}) to start their conversations.`, { afterTurn: true });
      return { prompted: true };
    }
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
          "Open a Spectra Council review in the canvas: several AI reviewers examine a repository, folder or document independently and report structured findings with evidence, then deliberate over them in rounds (backing, challenging, conceding) until a synthesis settles each finding as agreed, confirmed, disputed or withdrawn; the user watches it all live. The target is the project you work in unless the user names something narrower; the user chooses the profile, depth and reviewers in the canvas and starts the review there. Seats are the user's Mirador profiles (real agents, each turn a new conversation on that profile), by default the first two; deterministic mock personas only when the user asks for a mock or demo review. Read a review's progress and findings with council_status.",
        input: jsonSchema(openInput),
        async run(input, context) {
          const parsed = openInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const { target, profile = "general", depth = "standard", rounds, maxFindings, agents, instructions = "", title } = parsed.data;
          if (!isAbsolute(target)) throw new Error(`The target must be an absolute path; got ${target}.`);
          if ((await targetKind(target)) === null) throw new Error(`There is no file or folder at ${target}.`);
          // Real agents unless asked otherwise: mocks only when the agent names them.
          const seats = (agents ?? profilesFor(context.storage).slice(0, DEFAULT_SEATS).map((known) => profileAgent(known.name))).map((seat) =>
            typeof seat === "string" ? { agent: seat, enabled: true } : { agent: seat.agent, enabled: true, ...choiceOf(seat) },
          );
          const setup: Setup = { target, profile, depth, seats, instructions, ...(rounds === undefined ? {} : { deliberationRounds: rounds }), ...(maxFindings === undefined ? {} : { maxFindings }) };
          const review = identified(newReview(newId(), setup, runnerKindOf(seats), clock.now()));
          const item = context.publish({ type: ITEM_TYPE, title: title ?? `${PROFILES[profile].title} review · ${basename(target)}`, data: review });
          const seated = seatedReviewers(review).map((reviewer) =>
            isProfileAgent(reviewer.agent) ? `${reviewer.label} (${[`${profileName(reviewer.agent)} profile`, choiceText(reviewer.choice)].filter(Boolean).join(", ")})` : `${reviewer.label} (mock)`,
          );
          const seating = seated.length > 0 ? `seating ${seated.join(", ")}` : "with no reviewer seated yet (no Mirador profile is known)";
          return `Opened Spectra Council review ${review.id} (item ${item.id}) in the canvas, in setup, ${seating}, ${knobsText(review)}. The user picks the profile, depth and reviewers there and starts it; you hear when it ends, and council_status reads its findings.`;
        },
      },
      council_begin: {
        description:
          "Start a Spectra Council review the user pressed Start (or Resume) on, when it asks you to: starts a conversation for each seat on its Mirador profile. Also starts the re-check of fixes of a complete review, when the canvas asks. Only call it when the canvas asks; the review then runs on its own and you hear when it ends.",
        input: jsonSchema(beginInput),
        async run(input, context) {
          const parsed = beginInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const item = itemFor(context, parsed.data.review);
          const review = await startable(item);
          begin(item, context, review);
          const seated = seatedReviewers(review).map((reviewer) => reviewer.label);
          if (hasFixedFinding(review)) return `Started the re-check of the fixes of review ${review.id}. It runs in the canvas on its own; you hear when it ends. There is nothing more for you to do now.`;
          return `${review.phase === "setup" ? "Started" : "Resumed"} review ${review.id} with ${seated.join(", ")}. It runs in the canvas on its own; you hear when it ends. There is nothing more for you to do now.`;
        },
      },
      council_status: {
        description: "Read a Spectra Council review: its phase, each reviewer's status, and every finding with its severity, confidence and evidence.",
        input: jsonSchema(statusInput),
        run(input, context) {
          const parsed = statusInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          return describeReview(current(itemFor(context, parsed.data.review), context));
        },
      },
      council_delegate_fix: {
        description:
          "Hand a Spectra Council review's work that waits for a fixer profile to that profile: the findings the user handed it to fix (Ask … to fix), or the user's own ask they sent it. Starts a conversation on it with the hand-off; the canvas shows what it fixed when it reports back. You don't do that work yourself.",
        input: jsonSchema(delegateInput),
        async run(input, context) {
          const parsed = delegateInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const item = itemFor(context, parsed.data.review);
          const review = current(item, context);
          if (!review.handoff) throw new Error(`Review ${review.id} has no hand-off yet; the user writes it in the canvas.`);
          const waiting = review.findings.filter(awaitsDelegation);
          const asked = (review.asks ?? []).findIndex((ask) => ask.fixer && ask.fixer.conversationId === null && ask.fixer.endedAt === null);
          if (waiting.length === 0 && asked < 0) throw new Error(`Nothing of review ${review.id} waits for a fixer profile; the user picks one in the conversation header and hands findings or an ask to it.`);
          // Two calls at once would both start a conversation for the same work.
          if (delegating.has(item.id)) throw new Error(`A fixer conversation for review ${review.id} is being started; call council_delegate_fix again once it has.`);
          delegating.add(item.id);
          try {
            if (waiting.length === 0) {
              const { profile } = review.asks![asked]!.fixer!;
              let started: Awaited<ReturnType<typeof context.startConversation>>;
              try {
                const prompt = askFixerPrompt(review, asked, review.handoff.path);
                started = await context.startConversation({ profile, prompt, title: promptTitle(prompt) });
              } catch (error) {
                // Ended with the reason, so the canvas shows why instead of "starting…", and the user can ask again.
                const problem = `Couldn't start a conversation on ${profile}: ${error instanceof Error ? error.message : String(error)}`;
                const fixer = current(item, context).asks?.[asked]?.fixer;
                if (fixer && fixer.conversationId === null && fixer.endedAt === null) applyTo(item, context, { type: "ask-failed", at: clock.now(), ask: asked, problem });
                throw error;
              }
              applyTo(item, context, { type: "ask-delegated", at: clock.now(), ask: asked, conversationId: started.id });
              return `Started a conversation on ${started.profile} with the user's ask about review ${review.id}. The canvas shows what it fixed or filed when it reports back; there is nothing more for you to do.`;
            }
            return await delegateFixes(item, context, review, waiting, asked >= 0);
          } finally {
            delegating.delete(item.id);
          }
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
          const next = applyTo(item, context, { type: "fix-reported", at: clock.now(), findingId: finding, summary, files });
          const open = next.findings.filter((each) => each.fix && (each.fix.state === "handed-off" || each.fix.state === "reopened")).map(({ id }) => id);
          return `Marked ${finding} fixed in review ${next.id}.${open.length > 0 ? ` Still to fix: ${open.join(", ")}.` : uncheckableFixes(next).length > 0 ? " Every handed-off finding is fixed, but no reviewer who completed the review is left to re-check them." : " Every handed-off finding is fixed; the user can have the council re-check them."}`;
        },
      },
      council_mark_ticketed: {
        description:
          "Report that you filed a beads issue for an accepted finding of a Spectra Council review: the finding and the issue's id. The finding then shows its ticket in the canvas.",
        input: jsonSchema(markTicketedInput),
        run(input, context) {
          const parsed = markTicketedInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const { review: wanted, finding, ticket } = parsed.data;
          const item = itemFor(context, wanted);
          const next = applyTo(item, context, { type: "ticketed", at: clock.now(), findingId: finding, ticket });
          const open = next.findings.filter((each) => each.ticket && !each.ticket.id).map(({ id }) => id);
          return `Recorded ${ticket} for ${finding} in review ${next.id}.${open.length > 0 ? ` Still to file: ${open.join(", ")}.` : ""}`;
        },
      },
      council_stop: {
        description:
          "Stop a running Spectra Council review, or the re-check of its fixes, when the user asks you to. The review stops waiting for its reviewers and ends as stopped (a stopped re-check leaves the review complete); their conversations are stopped too, except on a Mirador older than plugin API 10, where they finish the turn they are in.",
        input: jsonSchema(stopInput),
        run(input, context) {
          const parsed = stopInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const item = itemFor(context, parsed.data.review);
          const session = sessions.get(item.id);
          if (!session || !isRunning(session.review)) {
            const review = current(item, context);
            return `Review ${review.id} isn't running (phase: ${review.phase}); there is nothing to stop.`;
          }
          const stopping = session.review.phase === "verification" ? "the re-check of the fixes of review" : "review";
          session.stop();
          return `Stopped ${stopping} ${session.review.id}.`;
        },
      },
      council_profiles: {
        description:
          "List the Mirador profiles Spectra Council can seat as reviewers, by the exact name council_open's agents take (\"profile:\" and the name), with the model each last ran on where known.",
        input: jsonSchema(z.object({})),
        run(_input, context) {
          const known = profilesFor(context.storage);
          if (known.length === 0) return "No Mirador profile is known to Spectra Council yet; the user can pick reviewers in the review's setup.";
          return ["Mirador profiles to seat:", ...known.map((profile) => `- profile:${profile.name}${profile.model ? ` (${modelLabel(profile.model)})` : ""}`)].join("\n");
        },
      },
      council_rule: {
        description:
          "Record the user's ruling on a finding of a complete Spectra Council review: accepted, dismissed or deferred, with their reason; null clears it. Only for a decision the user gave you: rulings are theirs, as in the canvas.",
        input: jsonSchema(ruleInput),
        run(input, context) {
          const parsed = ruleInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const { review: wanted, finding: findingId, decision, note = "" } = parsed.data;
          const item = itemFor(context, wanted);
          const review = current(item, context);
          const before = review.findings.find((finding) => finding.id === findingId);
          if (!before) throw new Error(`Review ${review.id} has no finding ${findingId}; its findings are ${review.findings.map(({ id }) => id).join(", ") || "none"}.`);
          const after = applyTo(item, context, { type: "ruled", at: clock.now(), findingId, decision, note });
          const ruled = decision === null ? `Cleared the ruling on ${findingId}` : `${RULING_VERBS[decision]} ${findingId}`;
          return [`${ruled} in review ${after.id}.`, ...rulingConsequences(before, after.findings.find((finding) => finding.id === findingId))].join(" ");
        },
      },
    }),
    guidance: {
      instructions:
        "- council_open: when the user wants several AI agents to review a repository, folder or document (a Spectra Council review), open one in the canvas with the target's absolute path; the user sets it up and starts it there. Leave agents out to seat the user's profiles, or name them as council_profiles lists them; seat mock personas only when the user asks for a mock or demo review. When the canvas asks you to call council_begin, do; when the user asks you to stop a running review, call council_stop. council_status reads its progress and findings; council_rule records a ruling the user gives you on a finding, never one of your own; when the user hands findings off to you to fix, call council_mark_fixed after each fix, or council_delegate_fix when asked to hand them to another profile; when asked to file beads issues for findings, call council_mark_ticketed after each.",
    },
    async action(item, action, context) {
      const parsed = viewActionSchema.safeParse(action);
      if (!parsed.success) throw new Error(`Unknown action: ${problemsOf(parsed.error)}`);
      switch (parsed.data.kind) {
        case "configure":
          context.change(item.id, { data: identified(reduceOrSay(settled(item), { type: "configured", patch: parsed.data.patch })) });
          return null;
        case "start":
          return start(item, context);
        case "rule": {
          const { findingId, decision, note } = parsed.data;
          const before = settled(item).findings.find((finding) => finding.id === findingId);
          const after = applyTo(item, context, { type: "ruled", at: clock.now(), findingId, decision, note });
          const ticket = before?.ticket?.id;
          if (ticket && decision !== "accepted" && before?.ruling?.decision === "accepted") {
            await context.prompt(
              `The user ${decision === null ? "cleared the ruling on" : decision === "dismissed" ? "dismissed" : "deferred"} ${findingId} of Spectra Council review ${after.id}, which has the beads issue ${ticket}. Tell the user, and close or update ${ticket} only if they want you to.`,
              { afterTurn: true },
            );
          }
          if (before?.fix && !after.findings.find((finding) => finding.id === findingId)?.fix) {
            const fixer = before.fix.fixer ? ` It was handed to the "${before.fix.fixer.profile}" profile, whose conversation can't hear this; its report on ${findingId} will be ignored.` : "";
            await context.prompt(
              `The user took ${findingId} out of the fixes for Spectra Council review ${after.id} (${decision === null ? "ruling cleared" : decision}). Don't fix it; if you already changed something for it, tell the user what.${fixer}`,
              { afterTurn: true },
            );
          }
          return null;
        }
        case "retry": {
          const session = sessions.get(item.id);
          if (!session) throw new Error("This review isn't running; only a running review's reviewer can be retried.");
          try {
            session.retry(parsed.data.reviewerId);
          } catch (error) {
            if (error instanceof ReviewError) throw new Error(error.message);
            throw error;
          }
          return null;
        }
        case "remove": {
          applyTo(item, context, { type: "reviewer-removed", reviewerId: parsed.data.reviewerId, at: clock.now() });
          return null;
        }
        case "fetch-reply":
          return fetchReply(item, context, parsed.data.reviewerId);
        case "resume":
          return start(item, context);
        case "handoff":
          await writeHandoff(item, context);
          return null;
        case "fix":
          return requestFixes(item, context);
        case "tickets":
          return requestTickets(item, context);
        case "ask":
          return ask(item, context, parsed.data.text, parsed.data.toFixer ?? false);
        case "beads":
          return { workspace: await beadsFor(settled(item)) };
        case "verify":
          return verify(item, context);
        case "rerun":
          return rerun(item, context);
        case "fixer":
          return { profile: context.profileSetting(FIXER_SETTING) || null };
        case "resolve-path":
          return { path: await resolveTargetPath(item.data.target, parsed.data.path) };
        case "profiles":
          return { profiles: profilesFor(context.storage) };
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
     * says it fixed as fixed, and the rest says why not. The review's own conversation is told once what came of it,
     * so its agent can say so to the user; one no review owns changes nothing and says nothing.
     */
    replied(started, reply, context) {
      const reviewer = pending.get(started.id);
      if (reviewer) {
        pending.delete(started.id);
        reviewer(reply);
        return;
      }
      // A reviewer's conversation that ended while no review waited for it: kept for a resume after a restart, or, when its
      // turn's limit gave up on it, for the user to fetch, which the review's conversation hears of.
      const flight = inFlight(context.storage)[started.id];
      if (flight) {
        keepInFlight(context.storage, (all) => {
          if (all[started.id]) all[started.id] = { ...all[started.id]!, reply };
        });
        // The tell addresses the chair the record names; a context aimed elsewhere would prompt a stranger's conversation,
        // so the reply stays kept and the misaim is only logged.
        if (flight.gaveUp && reply.ended === "finished") {
          if (flight.chair === context.conversationId) tellOfLateReply(flight.review, started.id, context);
          else console.error(`spectra-council: ${started.id}'s reply came through conversation ${context.conversationId}, not its review's own ${flight.chair}; its reply is kept, untold.`);
        }
        return;
      }
      const ended = reply.ended === "stopped" ? "was stopped" : "failed";
      for (const item of councilItems(context)) {
        const review = current(item, context);
        const askIndex = (review.asks ?? []).findIndex((ask) => ask.fixer?.conversationId === started.id);
        const mine = review.findings.filter((finding) => finding.fix?.fixer?.conversationId === started.id);
        if (askIndex < 0 && mine.length === 0) continue;
        const at = clock.now();
        const report = reply.ended === "finished" ? parseFixerReport(reply.text) : null;
        // A re-check may be running: the events go through its session, like the agent's own reports.
        const refused: string[] = [];
        const fixed: string[] = [];
        const notFixed: { finding: string; reason: string }[] = [];
        const apply = (event: ReviewEvent) => {
          try {
            applyTo(item, context, event);
            return true;
          } catch (error) {
            console.error(`spectra-council: a fixer report for review ${review.id} was refused:`, error);
            refused.push(error instanceof Error ? error.message : String(error));
            return false;
          }
        };
        // Only what was recorded reaches the telling: a refused part is in `problem`'s words instead, on both paths.
        const refusedProblem = () => (refused.length > 0 ? `Part of ${started.profile}'s report wasn't recorded: ${refused.join(" ")}` : null);
        const tickets: { finding: string; ticket: string }[] = [];
        const tell = (problem: string | null) =>
          void promptAfterTurn(context, fixerFinishedPrompt(review, started.profile, { fixed, notFixed, tickets, problem }), `review ${review.id} has its fixer's report`);
        if (askIndex >= 0) {
          // The user's own ask: what it reports about the findings asked about counts; the user said what to do.
          const about = new Set(review.asks![askIndex]!.findingIds);
          // A finding another fixer conversation is working on is that one's to report on.
          const elsewhere = (id: string) => {
            const fixer = review.findings.find((finding) => finding.id === id)?.fix?.fixer;
            return !!fixer?.conversationId && fixer.conversationId !== started.id;
          };
          for (const entry of report?.fixed ?? []) {
            if (!about.has(entry.finding)) continue;
            if (apply({ type: "fix-reported", at, findingId: entry.finding, summary: entry.summary, files: entry.files })) fixed.push(entry.finding);
          }
          for (const entry of report?.notFixed ?? []) {
            if (!about.has(entry.finding) || elsewhere(entry.finding)) continue;
            if (apply({ type: "fix-failed", at, findingIds: [entry.finding], reason: `${started.profile}: ${entry.reason}` })) notFixed.push({ finding: entry.finding, reason: entry.reason });
          }
          for (const filed of report?.tickets ?? []) {
            if (!about.has(filed.finding)) continue;
            if (apply({ type: "ticketed", at, findingId: filed.finding, ticket: filed.ticket })) tickets.push(filed);
          }
          const problem =
            reply.ended !== "finished"
              ? `${started.profile}'s conversation ${ended} before it reported.`
              : !report
                ? `${started.profile} ended without the JSON report; read its conversation to see what it did.`
                : refusedProblem();
          apply({ type: "ask-answered", at, ask: askIndex, problem });
          tell(problem);
          continue;
        }
        const ids = new Set(mine.map(({ id }) => id));
        const heard = new Set<string>();
        for (const entry of report?.fixed ?? []) {
          if (!ids.has(entry.finding)) continue;
          heard.add(entry.finding);
          if (apply({ type: "fix-reported", at, findingId: entry.finding, summary: entry.summary, files: entry.files })) fixed.push(entry.finding);
        }
        for (const entry of report?.notFixed ?? []) {
          if (!ids.has(entry.finding) || heard.has(entry.finding)) continue;
          heard.add(entry.finding);
          if (apply({ type: "fix-failed", at, findingIds: [entry.finding], reason: `${started.profile}: ${entry.reason}` })) notFixed.push({ finding: entry.finding, reason: entry.reason });
        }
        const silent = [...ids].filter((id) => !heard.has(id));
        if (silent.length > 0) {
          const reason =
            reply.ended !== "finished"
              ? `${started.profile}'s conversation ${ended} before it reported.`
              : report
                ? `${started.profile} didn't report on it.`
                : `${started.profile} ended without the JSON report; read its conversation to see what it changed.`;
          if (apply({ type: "fix-failed", at, findingIds: silent, reason })) for (const id of silent) notFixed.push({ finding: id, reason });
        }
        tell(refusedProblem());
      }
    },
    /**
     * A review that ended since the agent last heard: it hears with the user's next message, once. A run that reached
     * its verdict marks itself heard as its finished prompt goes out, so this carries the endings that came without one.
     */
    note(context) {
      const ended = councilItems(context).filter(({ data }) => data.startedAt !== null && isFinished(data) && data.agentHeardAt === null);
      if (ended.length === 0) return null;
      return {
        text: ended.map(({ data }) => `Spectra Council review ${data.id} ended (${data.phase}): ${outcomeOf(data)}. council_status reads its findings.`).join("\n"),
        heard: () => {
          for (const { id } of ended) {
            const latest = context.items().find((item) => item.id === id);
            if (latest) applyTo(latest, context, { type: "agent-heard", at: clock.now() });
          }
        },
      };
    },
  };
}

export default createCouncilHost({ records: miradorRecords() });
