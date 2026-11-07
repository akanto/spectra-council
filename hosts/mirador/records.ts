/**
 * What the plugin reads from Mirador's own records, which its plugin API doesn't offer yet (docs/mirador-api.md, 1 and
 * 4): the user's profiles, and the model and effort a conversation runs on. Mirador keeps both in its SQLite database
 * (`$MIRADOR_DATA_DIR/state.sqlite`, by default `~/.mirador/state.sqlite`), which this opens read-only. Anything it
 * can't read gives an empty answer, never an error: the council then names seats by their profiles, as before.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileInfo } from "../../core/agents.ts";
import type { ModelInfo } from "../../core/model.ts";

export interface MiradorRecords {
  /** The user's profiles, in Mirador's order (oldest first), each with the model its latest conversation ran on. */
  profiles(): ProfileInfo[];
  /** The model and effort a conversation runs on, from its header's choices; null until its session reported them. */
  modelOf(conversationId: string): ModelInfo | null;
}

/** Records that know nothing, for tests and hosts without Mirador's database. */
export const noRecords: MiradorRecords = { profiles: () => [], modelOf: () => null };

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
          try {
            for (const c of convs.all(r.id) as { config_options: string }[]) {
              model = modelFromOptions(optionsOf(c.config_options), r.effort);
              if (model) break;
            }
          } catch {
            model = null;
          }
          return { name: String(r.name), harness: String(r.harness), model };
        });
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
