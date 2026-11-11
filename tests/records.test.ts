import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { choicesFromOptions, miradorDatabase, miradorRecords, modelFromOptions, noRecords, replyFromEvents } from "../hosts/mirador/records.ts";

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
      {
        name: "Claude",
        harness: "claude",
        model: { name: "Opus 5.5", effort: "max" },
        models: [
          { value: "opus", name: "Opus 5.5" },
          { value: "sonnet", name: "Sonnet 5.5" },
        ],
        efforts: [],
      },
      {
        name: "Pi",
        harness: "pi",
        model: { name: "Qwen 3.8 Max", effort: "medium" },
        models: [
          { value: "alibaba-plan/qwen3.8-max", name: "Qwen 3.8 Max" },
          { value: "opencode-go/glm-5.3", name: "GLM-5.3" },
        ],
        efforts: [{ value: "medium", name: "medium" }],
      },
      { name: "Fresh", harness: "claude", model: null, models: [], efforts: [] },
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

/** A chunk of the agent's message, as Mirador stores an ACP update. */
const said = (text: string, messageId = "m1", meta?: Record<string, unknown>) => ({ type: "acp", update: { content: { text, type: "text" }, messageId, sessionUpdate: "agent_message_chunk", ...(meta ? { _meta: meta } : {}) } });
const thought = (text: string) => ({ type: "acp", update: { content: { text, type: "text" }, sessionUpdate: "agent_thought_chunk" } });
const toolCall = (id: string) => ({ type: "acp", update: { toolCallId: id, title: "Read", sessionUpdate: "tool_call" } });
const asked = { type: "user-message", text: "Review this." };
const turnEnd = (stopReason = "end_turn") => ({ type: "turn-end", stopReason });

describe("replyFromEvents", () => {
  test("the agent's last message, after thoughts and tool calls, of a turn that ended", () => {
    const reply = replyFromEvents([asked, thought("Let me look."), said("First "), said("look."), toolCall("t1"), thought("Hm."), said("Done.\n\n```json\n", "m2"), said('{"findings": []}\n```', "m2"), turnEnd()]);
    expect(reply).toEqual({ text: 'Done.\n\n```json\n{"findings": []}\n```', ended: "finished" });
  });

  test("a turn with no end is running; a cancelled one stopped; an error that ends the turn failed", () => {
    expect(replyFromEvents([asked, said("Working on it")])).toEqual({ text: "Working on it", ended: "running" });
    expect(replyFromEvents([asked, said("Half"), turnEnd("cancelled")])).toEqual({ text: "Half", ended: "stopped" });
    expect(replyFromEvents([asked, said("Half"), { type: "error", message: "gone", endsTurn: true }])).toEqual({ text: "Half", ended: "failed" });
    // An error that doesn't end the turn changes nothing.
    expect(replyFromEvents([asked, { type: "error", message: "retrying" }, said("Fine."), turnEnd()])).toEqual({ text: "Fine.", ended: "finished" });
  });

  test("a plan, a permission, an error, a new tool call or an image ends a message, as in Mirador's timeline", () => {
    const fence = "```json\n{}\n```";
    const plan = { type: "acp", update: { entries: [], sessionUpdate: "plan" } };
    const image = { type: "acp", update: { content: { type: "image", data: "x", mimeType: "image/png" }, messageId: "m1", sessionUpdate: "agent_message_chunk" } };
    for (const between of [plan, { type: "permission" }, { type: "error", message: "retrying" }, image, { type: "acp", update: { toolCallId: "new", sessionUpdate: "tool_call_update" } }]) {
      expect(replyFromEvents([asked, said("All checked."), between, said(fence, "m2"), turnEnd()]).text).toBe(fence);
    }
    // An update of a tool call already shown doesn't.
    const update = { type: "acp", update: { toolCallId: "t1", status: "completed", sessionUpdate: "tool_call_update" } };
    expect(replyFromEvents([asked, toolCall("t1"), said("One "), update, said("two"), turnEnd()]).text).toBe("One two");
    const child = said("A child session's words", "c1", { "opencode/child-session": { id: "s2" } });
    expect(replyFromEvents([asked, said("Mine"), child, turnEnd()]).text).toBe("Mine");
  });

  test("nothing said in words is a null text", () => {
    expect(replyFromEvents([asked, thought("..."), toolCall("t1"), said("   "), turnEnd()])).toEqual({ text: null, ended: "finished" });
  });

  test("a subagent's message, an informational one and a repeat of the whole message don't count", () => {
    const sub = said("The subagent's report", "s1", { claudeCode: { parentToolUseId: "t1" } });
    const info = said("Compacted.", "i1", { claudeCode: { kind: "informational" } });
    expect(replyFromEvents([asked, said("Mine"), sub, turnEnd()]).text).toBe("Mine");
    expect(replyFromEvents([asked, said("Mine"), info, turnEnd()]).text).toBe("Mine");
    expect(replyFromEvents([asked, said("One, "), said("two."), said("One, two."), turnEnd()]).text).toBe("One, two.");
  });
});

describe("miradorRecords.replyOf", () => {
  const dir = mkdtempSync(join(tmpdir(), "records-reply-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  // Mirador's events table, as in its state.sqlite.
  db.run("CREATE TABLE events (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (conversation_id, seq))");
  const add = (conversation: string, events: unknown[]) => events.forEach((event, index) => db.run("INSERT INTO events VALUES (?, ?, ?, ?)", [conversation, index + 1, 1000 + index, JSON.stringify(event)]));
  add("finished", [asked, { type: "files-kept", turnSeq: 1, checkpoint: "x" }, said("Here.\n```json\n{\"findings\": []}\n```"), turnEnd()]);
  add("working", [asked, thought("Reading"), toolCall("t1")]);
  // A second message began a new turn: its reply is the one that counts.
  add("again", [asked, said("Old answer"), turnEnd(), { type: "user-message", text: "And now?" }, said("New answer")]);
  add("silent", [{ type: "files-kept", turnSeq: 1, checkpoint: "x" }]);
  db.run("INSERT INTO events VALUES ('broken', 1, 1, ?), ('broken', 2, 2, 'not json'), ('broken', 3, 3, ?)", [JSON.stringify(asked), JSON.stringify(turnEnd())]);
  db.close();
  const records = miradorRecords(path);

  test("a finished turn's reply", () => expect(records.replyOf("finished")).toEqual({ text: 'Here.\n```json\n{"findings": []}\n```', ended: "finished" }));
  test("a turn still running", () => expect(records.replyOf("working")).toEqual({ text: null, ended: "running" }));
  test("the latest turn's", () => expect(records.replyOf("again")).toEqual({ text: "New answer", ended: "running" }));
  test("no turn, no conversation, or no database: null", () => {
    expect(records.replyOf("silent")).toBeNull();
    expect(records.replyOf("nope")).toBeNull();
    expect(miradorRecords(join(dir, "absent", "state.sqlite")).replyOf("finished")).toBeNull();
    expect(noRecords.replyOf("finished")).toBeNull();
  });
  test("an unreadable event is skipped", () => expect(records.replyOf("broken")).toEqual({ text: null, ended: "finished" }));
});

describe("choicesFromOptions", () => {
  test("models of the same name from two providers keep their prefixes", () => {
    const options = [
      {
        id: "model",
        category: "model",
        currentValue: "a/glm-5.2",
        options: [
          { value: "a/glm-5.2", name: "a/GLM-5.2" },
          { value: "b/glm-5.2", name: "b/GLM-5.2" },
          { value: "a/qwen", name: "a/Qwen" },
        ],
      },
    ];
    expect(choicesFromOptions(options).models).toEqual([
      { value: "a/glm-5.2", name: "a/GLM-5.2" },
      { value: "b/glm-5.2", name: "b/GLM-5.2" },
      { value: "a/qwen", name: "Qwen" },
    ]);
  });

  test("drops the default model and the off effort, keeps values and names", () => {
    expect(choicesFromOptions(claude())).toEqual({
      models: [
        { value: "opus", name: "Opus 5.5" },
        { value: "sonnet", name: "Sonnet 5.5" },
      ],
      efforts: [
        { value: "low", name: "low" },
        { value: "high", name: "high" },
      ],
    });
  });
  test("strips a provider prefix from a model name and cleans a Thinking: effort", () => {
    expect(choicesFromOptions(pi)).toEqual({
      models: [
        { value: "alibaba-plan/qwen3.8-max", name: "Qwen 3.8 Max" },
        { value: "opencode-go/glm-5.3", name: "GLM-5.3" },
      ],
      efforts: [{ value: "medium", name: "medium" }],
    });
  });
  test("a default effort is dropped too", () => {
    const options = [{ id: "effort", category: "thought_level", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }] }];
    expect(choicesFromOptions(options).efforts).toEqual([{ value: "high", name: "high" }]);
  });
  test("no model or effort option gives empty lists", () => {
    expect(choicesFromOptions(claude("opus", null)).efforts).toEqual([]);
    expect(choicesFromOptions([{ id: "mode", category: "mode", options: [] }])).toEqual({ models: [], efforts: [] });
  });
  test("garbage gives empty lists", () => {
    for (const garbage of [null, undefined, 5, "x", {}, [null, 3, "x"]]) expect(choicesFromOptions(garbage)).toEqual({ models: [], efforts: [] });
  });
});
