/**
 * What the plugin reads from Mirador's own records, which its plugin API doesn't offer yet (docs/mirador-api.md): the
 * user's profiles with the models and efforts their agents offer, the model and effort a conversation runs on, and a
 * conversation's latest reply (for a reviewer's late reply, which Mirador told the plugin while nothing waited for it).
 * Mirador keeps them in its SQLite database (`$MIRADOR_DATA_DIR/state.sqlite`, by default `~/.mirador/state.sqlite`),
 * which this opens read-only. Anything it can't read gives an empty answer, never an error: the council then names seats
 * by their profiles, as before.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LateReply } from "../../core/agent-runner.ts";
import type { OptionChoice, ProfileInfo } from "../../core/agents.ts";
import type { ModelInfo } from "../../core/model.ts";

export interface MiradorRecords {
  /** The user's profiles, in Mirador's order (oldest first), each with the model its latest conversation ran on. */
  profiles(): ProfileInfo[];
  /** The model and effort a conversation runs on, from its header's choices; null until its session reported them. */
  modelOf(conversationId: string): ModelInfo | null;
  /**
   * What the agent said last in the conversation's latest turn, and how that turn ended ("running" while it hasn't), as
   * Mirador tells a plugin when a conversation it started replies (`replyFromEvents`); null when there is no such
   * conversation or turn.
   */
  replyOf(conversationId: string): LateReply | null;
}

/** Records that know nothing, for tests and hosts without Mirador's database. */
export const noRecords: MiradorRecords = { profiles: () => [], modelOf: () => null, replyOf: () => null };

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});

/**
 * The reply in a turn's events (Mirador's `events` rows, parsed, oldest first, from the message that began the turn), as
 * Mirador's own `replyOf` (shared/last-words.ts) reads it: the agent's last message, the run of its message chunks that
 * nothing Mirador's timeline shows as a block of its own broke (a thought, a new tool call, a plan, a notice, a mode
 * change, a permission, an error, an image, another message), trimmed (null when it said nothing in words); and how the
 * turn ended: the last `turn-end` (stopped when cancelled, else finished) or error that ended the turn (failed),
 * "running" when none did. A subagent's or an informational message doesn't count, nor a chunk that repeats its whole
 * message.
 */
export function replyFromEvents(events: unknown[]): LateReply {
  let last: string | null = null;
  let current: string | null = null;
  let ended: LateReply["ended"] = "running";
  const streamed = new Map<string, { text: string; chunks: number }>();
  const tools = new Set<string>();
  for (const raw of events) {
    const event = record(raw);
    if (event.type === "turn-end") {
      ended = event.stopReason === "cancelled" ? "stopped" : "finished";
      current = null;
      continue;
    }
    if (event.type === "error") {
      if (event.endsTurn === true) ended = "failed";
      current = null;
      continue;
    }
    if (event.type === "user-message" || event.type === "permission") {
      current = null;
      continue;
    }
    if (event.type !== "acp") continue;
    const update = record(event.update);
    const meta = record(update._meta);
    const claudeCode = record(meta.claudeCode);
    // A subagent's updates (Claude Code's tasks, opencode's child sessions) show in its own block.
    if (typeof claudeCode.parentToolUseId === "string" || meta["opencode/child-session"] !== undefined) continue;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = record(update.content);
        if (content.type !== "text" || typeof content.text !== "string") {
          current = null;
          continue;
        }
        if (claudeCode.kind === "informational") {
          current = null;
          continue;
        }
        const text = content.text;
        const messageId = typeof update.messageId === "string" ? update.messageId : null;
        if (messageId) {
          const chunks = Number(record(meta["mirador/coalesced"]).chunks) || 1;
          const soFar = streamed.get(messageId) ?? { text: "", chunks: 0 };
          // Some gateways follow a streamed message with one chunk that holds all of it again.
          if (soFar.chunks >= 2 && text.trim() !== "" && text === soFar.text) continue;
          streamed.set(messageId, { text: soFar.text + text, chunks: soFar.chunks + chunks });
        }
        current = (current ?? "") + text;
        last = current;
        continue;
      }
      case "tool_call":
      case "tool_call_update": {
        // An update of a tool call already shown changes its block; a new one is a block of its own.
        const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
        if (update.sessionUpdate === "tool_call" || id === null || !tools.has(id)) current = null;
        if (id !== null) tools.add(id);
        continue;
      }
      case "agent_thought_chunk":
      case "user_message_chunk":
      case "plan":
      case "notice":
      case "current_mode_update":
        current = null;
        continue;
    }
  }
  const text = last?.trim() || null;
  return { text, ended };
}

/** The database's path: `MIRADOR_DATA_DIR` as Mirador reads it, else `~/.mirador`. */
export function miradorDatabase(env: Record<string, string | undefined> = process.env): string {
  const dir = env.MIRADOR_DATA_DIR?.trim();
  return join(dir ? dir : join(homedir(), ".mirador"), "state.sqlite");
}

/**
 * The model and effort in a conversation's config options (the `config_options` JSON Mirador stores): the option of
 * category "model" and the one of category "thought_level", each by the name of its current choice. A model's name
 * loses any provider prefix ("alibaba-plan/Qwen 3.8 Max" → "Qwen 3.8 Max"); a "default" choice whose name isn't a
 * model ("Default (recommended)") takes its description ("Opus 5.5"). An effort loses a "Thinking:" prefix and is lower
 * case ("Thinking: medium" → "medium", "High" → "high"); "off" or none gives null. `profileEffort` stands in when the
 * options have no effort. Null when there is no model option or it can't be read.
 */
export function modelFromOptions(options: unknown, profileEffort: string | null = null): ModelInfo | null {
  const list = parseOptions(options);
  const modelOption = list.find((o) => o.category === "model") ?? list.find((o) => o.id === "model");
  if (!modelOption) return null;
  const choice = currentChoice(modelOption);
  if (!choice) return null;
  let name: string;
  if (choice.found && choice.value.toLowerCase() === "default" && choice.description) name = choice.description;
  else if (choice.found && choice.name) name = choice.name;
  else name = choice.value;
  name = stripProvider(name);
  if (!name) return null;

  const effortOption =
    list.find((o) => o.category === "thought_level") ?? list.find((o) => o.id === "effort" || o.id === "thought_level");
  const effortChoice = effortOption ? currentChoice(effortOption) : null;
  const effort = effortChoice
    ? cleanEffort(effortChoice.found && effortChoice.name ? effortChoice.name : effortChoice.value)
    : cleanEffort(profileEffort);
  return { name, effort };
}

/**
 * The models and efforts a conversation's config options offer, for a seat to choose from: the choices of the option of
 * category "model" (without a "default" one, which a seat gets by choosing none) and of the one of category
 * "thought_level" (without "default" or "off"), each by its value and its name. A model's name loses any provider prefix; an
 * effort's is cleaned as `modelFromOptions` cleans it. Models of the same name from two providers keep the prefix.
 */
export function choicesFromOptions(options: unknown): { models: OptionChoice[]; efforts: OptionChoice[] } {
  const list = parseOptions(options);
  const modelOption = list.find((o) => o.category === "model") ?? list.find((o) => o.id === "model");
  const effortOption = list.find((o) => o.category === "thought_level") ?? list.find((o) => o.id === "effort" || o.id === "thought_level");
  const listed = (modelOption?.choices ?? []).filter((c) => c.value && c.value.toLowerCase() !== "default");
  const short = listed.map((c) => stripProvider(c.name || c.value) || c.value);
  // Two providers' models of the same name keep their prefixes, to tell them apart.
  const models = listed.map((c, i) => ({ value: c.value, name: short.filter((name) => name === short[i]).length > 1 ? c.name || c.value : short[i]! }));
  const efforts = (effortOption?.choices ?? []).flatMap((c) => {
    const name = cleanEffort(c.name || c.value);
    return c.value && c.value.toLowerCase() !== "default" && name ? [{ value: c.value, name }] : [];
  });
  return { models, efforts };
}

interface ParsedOption {
  id: string;
  category: string;
  currentValue: string;
  choices: { value: string; name: string; description: string }[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseOptions(options: unknown): ParsedOption[] {
  if (!Array.isArray(options)) return [];
  const out: ParsedOption[] = [];
  for (const raw of options) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const choices = Array.isArray(o.options)
      ? o.options.flatMap((c: unknown) => {
          if (!c || typeof c !== "object") return [];
          const r = c as Record<string, unknown>;
          return [{ value: str(r.value), name: str(r.name), description: str(r.description) }];
        })
      : [];
    out.push({ id: str(o.id), category: str(o.category), currentValue: str(o.currentValue), choices });
  }
  return out;
}

function currentChoice(option: ParsedOption) {
  if (!option.currentValue) return null;
  const hit = option.choices.find((c) => c.value === option.currentValue);
  return {
    found: hit !== undefined,
    value: option.currentValue,
    name: hit?.name ?? "",
    description: hit?.description ?? "",
  };
}

function stripProvider(name: string): string {
  const i = name.indexOf("/");
  return (i >= 0 ? name.slice(i + 1) : name).trim();
}

function cleanEffort(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().replace(/^thinking:\s*/i, "").trim().toLowerCase();
  return e === "" || e === "off" ? null : e;
}

/** Records read from the database at `path`, opened read-only for each read. */
export function miradorRecords(path: string = miradorDatabase()): MiradorRecords {
  /** Runs `read` on a fresh read-only connection; any failure gives `fallback`. */
  function withDb<T>(fallback: T, read: (db: Database) => T): T {
    let db: Database | null = null;
    try {
      db = new Database(path, { readonly: true });
      return read(db);
    } catch {
      return fallback;
    } finally {
      try {
        db?.close();
      } catch {
        // nothing to do
      }
    }
  }

  function optionsOf(configOptions: unknown): unknown {
    if (typeof configOptions !== "string") return null;
    try {
      return JSON.parse(configOptions);
    } catch {
      return null;
    }
  }

  return {
    profiles() {
      return withDb<ProfileInfo[]>([], (db) => {
        const rows = db
          .query("SELECT id, name, harness, effort FROM profiles ORDER BY created_at, rowid")
          .all() as { id: string; name: string; harness: string; effort: string | null }[];
        const convs = db.query("SELECT config_options FROM conversations WHERE profile_id = ? AND config_options != '[]' ORDER BY created_at DESC, rowid DESC LIMIT 20");
        return rows.map((r) => {
          let model: ModelInfo | null = null;
          let choices: ReturnType<typeof choicesFromOptions> = { models: [], efforts: [] };
          try {
            for (const c of convs.all(r.id) as { config_options: string }[]) {
              const options = optionsOf(c.config_options);
              model = modelFromOptions(options, r.effort);
              if (model) {
                choices = choicesFromOptions(options);
                break;
              }
            }
          } catch {
            model = null;
          }
          return { name: String(r.name), harness: String(r.harness), model, ...choices };
        });
      });
    },
    replyOf(conversationId) {
      return withDb<LateReply | null>(null, (db) => {
        // The turn is the latest message's, as Mirador's own reply is (a reviewer's conversation has only its first).
        const start = db
          .query("SELECT MAX(seq) AS seq FROM events WHERE conversation_id = ? AND CASE WHEN json_valid(event) THEN json_extract(event, '$.type') END = 'user-message'")
          .get(conversationId) as { seq: number | null } | null;
        if (start?.seq === null || start?.seq === undefined) return null;
        const rows = db.query("SELECT event FROM events WHERE conversation_id = ? AND seq >= ? ORDER BY seq").all(conversationId, start.seq) as { event: string }[];
        const events = rows.flatMap((row) => {
          try {
            return [JSON.parse(row.event) as unknown];
          } catch {
            return [];
          }
        });
        return replyFromEvents(events);
      });
    },
    modelOf(conversationId) {
      return withDb<ModelInfo | null>(null, (db) => {
        const row = db
          .query(
            "SELECT c.config_options AS config_options, p.effort AS effort FROM conversations c LEFT JOIN profiles p ON p.id = c.profile_id WHERE c.id = ?",
          )
          .get(conversationId) as { config_options: string; effort: string | null } | null;
        // The conversation's profile effort stands in when its options report none.
        return row ? modelFromOptions(optionsOf(row.config_options), row.effort) : null;
      });
    },
  };
}
