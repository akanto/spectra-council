/**
 * Spectra Council's canvas host, which Mirador runs in its own process. A review is a canvas item: the agent opens one
 * with council_open, the user sets it up and starts it in the view, and the engine's reviews go into the item's data,
 * which Mirador persists and sends to the view on every change.
 */
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { defaultSeats } from "../../core/agents.ts";
import { describeReview, outcomeOf } from "../../core/describe.ts";
import { ReviewSession, systemClock, type Clock } from "../../core/engine.ts";
import { isFinished, isRunning, seatedReviewers, type Review } from "../../core/model.ts";
import { MockRunner, type FileLister } from "../../core/mock-runner.ts";
import { PROFILES } from "../../core/profiles.ts";
import { newReview, reduce, ReviewError, upgradeReview, type ReviewEvent } from "../../core/review.ts";
import { depthSchema, problemsOf, profileIdSchema, SEATS, viewActionSchema, type Setup } from "../../core/schemas.ts";
import { listTargetFiles, targetKind } from "../../core/target-files.ts";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, PluginItem } from "./api.ts";

export const ITEM_TYPE = "council";

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
    .describe("Agent ids to seat, in order (mock-claude, mock-codex, mock-gemini, mock-qwen); default: the first two of four."),
  instructions: z.string().optional().describe("What the user asked the reviewers to pay attention to, in their words."),
  title: z.string().min(1).optional().describe('The review\'s title, e.g. "Architecture review of the payment service".'),
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
}

export function createCouncilHost({
  clock = systemClock,
  listFiles = listTargetFiles,
  newId = () => crypto.randomUUID().slice(0, 8),
  throttleMs = 250,
}: HostOptions = {}): CanvasHost<Review> {
  /** The reviews running in this process, by item id; one missing for a running review was cut short by a restart. */
  const sessions = new Map<string, ReviewSession>();

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

  function applyTo(item: PluginItem<Review>, context: CanvasPluginContext<Review>, event: ReviewEvent) {
    try {
      context.change(item.id, { data: reduce(settled(item), event) });
    } catch (error) {
      if (error instanceof ReviewError) throw new Error(error.message);
      throw error;
    }
  }

  async function start(item: PluginItem<Review>, context: CanvasActionContext<Review>) {
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const review = settled(item);
    if (review.phase !== "setup") throw new Error(`This review is ${review.phase}; ask the agent to open a new one.`);
    if (seatedReviewers(review).length === 0) throw new Error("Seat at least one reviewer before starting the review.");
    if (!isAbsolute(review.target) || (await targetKind(review.target)) === null) {
      throw new Error(`There is no file or folder at ${review.target}; give the absolute path of what to review.`);
    }
    if (sessions.has(item.id)) throw new Error("This review is already running.");
    const out = writer(context, item.id);
    const session = new ReviewSession(review, { runner: new MockRunner(listFiles, clock), clock, onChange: (next) => out.write(next) });
    sessions.set(item.id, session);
    // The engine ends each reviewer itself, failed or not; run() rejects only on a bug, which is logged.
    session
      .run()
      .catch((error) => console.error(`spectra-council: review ${review.id} failed:`, error))
      .finally(() => {
        out.flush();
        sessions.delete(item.id);
      });
    return null;
  }

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
    tools: {
      council_open: {
        description:
          "Open a Spectra Council review in the canvas: several AI reviewers examine a repository, folder or document independently and report structured findings with evidence, then deliberate over them in rounds (backing, challenging, conceding) until a synthesis settles each finding as agreed, confirmed, disputed or withdrawn; the user watches it all live. The target is the project you work in unless the user names something narrower; the user chooses the profile, depth and reviewers in the canvas and starts the review there. Reviewers are deterministic mocks for now, so their findings are illustrative. Read a review's progress and findings with council_status.",
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
          const review = newReview(newId(), setup, "mock", clock.now());
          const item = context.publish({ type: ITEM_TYPE, title: title ?? `${PROFILES[profile].title} review · ${basename(target)}`, data: review });
          return `Opened Spectra Council review ${review.id} (item ${item.id}) in the canvas, in setup. The user picks the profile, depth and reviewers there and starts it; you hear when it ends, and council_status reads its findings. The reviewers are deterministic mocks for now.`;
        },
      },
      council_status: {
        description: "Read a Spectra Council review: its phase, each reviewer's status, and every finding with its severity, confidence and evidence.",
        input: jsonSchema(statusInput),
        run(input, context) {
          const parsed = statusInput.safeParse(input);
          if (!parsed.success) throw new Error(problemsOf(parsed.error));
          const items = councilItems(context);
          const wanted = parsed.data.review;
          const item = wanted ? items.find(({ id, data }) => id === wanted || data.id === wanted) : items.at(-1);
          if (!item) throw new Error(wanted ? `No review ${wanted} in this conversation; its reviews are ${items.map(({ data }) => data.id).join(", ") || "none"}.` : "This conversation has no Spectra Council review; open one with council_open.");
          return describeReview(settled(item));
        },
      },
    },
    guidance: {
      instructions:
        "- council_open: when the user wants several AI agents to review a repository, folder or document (a Spectra Council review), open one in the canvas with the target's absolute path; the user sets it up and starts it there. council_status reads its progress and findings.",
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
        case "stop": {
          const session = sessions.get(item.id);
          if (session) session.stop();
          else applyTo(item, context, { type: "stopped", at: clock.now() });
          return null;
        }
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
