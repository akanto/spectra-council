import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { miradorDatabase, miradorRecords, modelFromOptions, noRecords } from "../hosts/mirador/records.ts";

const claude = (current = "opus", effort: string | null = "high") => [
  { id: "mode", category: "mode", type: "select", currentValue: "default", options: [] },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: [
      { value: "default", name: "Default (recommended)", description: "Opus 5.5" },
      { value: "opus", name: "Opus 5.5", description: "For complex work" },
      { value: "sonnet", name: "Sonnet 5.5", description: "..." },
    ],
  },
  ...(effort
    ? [
        {
          id: "effort",
          category: "thought_level",
          type: "select",
          currentValue: effort,
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
            { value: "off", name: "Off" },
          ],
        },
      ]
    : []),
  { id: "fast", category: "model_config", currentValue: "off", options: [] },
];

const pi = [
  {
    type: "select",
    id: "model",
    category: "model",
    name: "Model",
    currentValue: "alibaba-plan/qwen3.8-max",
    options: [
      { value: "alibaba-plan/qwen3.8-max", name: "alibaba-plan/Qwen 3.8 Max", description: null },
      { value: "opencode-go/glm-5.3", name: "opencode-go/GLM-5.3", description: null },
    ],
  },
  {
    id: "thought_level",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Thinking: medium" },
      { value: "off", name: "Thinking: off" },
    ],
  },
];

describe("modelFromOptions", () => {
  test("Claude Code", () => expect(modelFromOptions(claude())).toEqual({ name: "Opus 5.5", effort: "high" }));
  test("pi", () => expect(modelFromOptions(pi)).toEqual({ name: "Qwen 3.8 Max", effort: "medium" }));
  test("default choice takes its description", () =>
    expect(modelFromOptions(claude("default"))).toEqual({ name: "Opus 5.5", effort: "high" }));
  test("unknown currentValue is used, minus provider prefix", () => {
    expect(modelFromOptions(claude("mystery"))?.name).toBe("mystery");
    const opts = [{ id: "model", category: "model", currentValue: "acme/zed-1", options: [] }];
    expect(modelFromOptions(opts)).toEqual({ name: "zed-1", effort: null });
  });
  test("missing effort uses profileEffort when given", () => {
    expect(modelFromOptions(claude("opus", null))).toEqual({ name: "Opus 5.5", effort: null });
    expect(modelFromOptions(claude("opus", null), "Medium")).toEqual({ name: "Opus 5.5", effort: "medium" });
  });
  test("off gives null, without falling back", () => {
    expect(modelFromOptions(claude("opus", "off"), "high")?.effort).toBeNull();
    const p = JSON.parse(JSON.stringify(pi));
    p[1].currentValue = "off";
    expect(modelFromOptions(p)?.effort).toBeNull();
  });
  test("garbage gives null", () => {
    for (const g of ["nope", null, undefined, 3, {}, [], [null, 1, "x"], [{ category: "model" }], [{ category: "model", options: "x" }]])
      expect(modelFromOptions(g)).toBeNull();
  });
});

describe("miradorDatabase", () => {
  test("with MIRADOR_DATA_DIR", () => expect(miradorDatabase({ MIRADOR_DATA_DIR: "/x/y" })).toBe("/x/y/state.sqlite"));
  test("without", () => expect(miradorDatabase({})).toBe(join(homedir(), ".mirador", "state.sqlite")));
  test("empty value counts as unset", () =>
    expect(miradorDatabase({ MIRADOR_DATA_DIR: "" })).toBe(join(homedir(), ".mirador", "state.sqlite")));
});

describe("miradorRecords", () => {
  const dir = mkdtempSync(join(tmpdir(), "records-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");

  const db = new Database(path);
  db.run(
    "CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL, prelaunch TEXT NOT NULL, created_at INTEGER NOT NULL, harness TEXT NOT NULL DEFAULT 'claude', mode TEXT, bypass_permissions INTEGER NOT NULL DEFAULT 0, ask_mode TEXT NOT NULL DEFAULT 'wait', color TEXT, effort TEXT, plugin_settings TEXT)",
  );
  db.run(
    "CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, harness TEXT NOT NULL, title TEXT NOT NULL, acp_session_id TEXT, ask_mode TEXT NOT NULL, config_options TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, profile_id TEXT)",
  );
  const addProfile = (id: string, name: string, at: number, harness: string, effort: string | null) =>
    db.run("INSERT INTO profiles (id, name, environment, prelaunch, created_at, harness, effort) VALUES (?, ?, '', '', ?, ?, ?)", [id, name, at, harness, effort]);
  const addConv = (id: string, profile: string | null, at: number, opts: string) =>
    db.run("INSERT INTO conversations (id, workspace_id, harness, title, ask_mode, config_options, created_at, updated_at, profile_id) VALUES (?, 'w', 'claude', 't', 'wait', ?, ?, ?, ?)", [id, opts, at, at, profile]);
  addProfile("p2", "Pi", 20, "pi", "low");
  addProfile("p1", "Claude", 10, "claude", "max");
  addProfile("p3", "Fresh", 30, "claude", null);
  addConv("c1", "p1", 100, JSON.stringify(claude("sonnet", "low")));
  addConv("c2", "p1", 200, JSON.stringify(claude("opus", null)));
  addConv("c3", "p1", 300, "[]");
  addConv("c4", "p1", 400, "not json");
  addConv("c5", "p2", 150, JSON.stringify(pi));
  db.close();

  const records = miradorRecords(path);

  test("profiles: ordered, latest conversation with a model, profile effort fallback", () => {
    expect(records.profiles()).toEqual([
      { name: "Claude", harness: "claude", model: { name: "Opus 5.5", effort: "max" } },
      { name: "Pi", harness: "pi", model: { name: "Qwen 3.8 Max", effort: "medium" } },
      { name: "Fresh", harness: "claude", model: null },
    ]);
  });

  test("modelOf", () => {
    expect(records.modelOf("c1")).toEqual({ name: "Sonnet 5.5", effort: "low" });
    expect(records.modelOf("c2")).toEqual({ name: "Opus 5.5", effort: "max" });
    expect(records.modelOf("c3")).toBeNull();
    expect(records.modelOf("c4")).toBeNull();
    expect(records.modelOf("nope")).toBeNull();
  });

  test("missing database", () => {
    const missing = miradorRecords(join(dir, "absent", "state.sqlite"));
    expect(missing.profiles()).toEqual([]);
    expect(missing.modelOf("c1")).toBeNull();
  });

  test("missing tables", () => {
    const empty = join(dir, "empty.sqlite");
    new Database(empty).close();
    expect(miradorRecords(empty).profiles()).toEqual([]);
    expect(miradorRecords(empty).modelOf("c1")).toBeNull();
  });

  test("noRecords", () => {
    expect(noRecords.profiles()).toEqual([]);
    expect(noRecords.modelOf("x")).toBeNull();
  });
});

describe("modelFromOptions, a capitalised default choice", () => {
  test("takes the description, as for a lower-case one", () => {
    const options = [{ id: "model", category: "model", currentValue: "Default", options: [{ value: "Default", name: "Default (recommended)", description: "Opus" }] }];
    expect(modelFromOptions(options)).toEqual({ name: "Opus", effort: null });
  });
});
