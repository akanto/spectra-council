import type { Clock } from "../core/engine.ts";
import type { CanvasActionContext, CanvasToolContext, PluginItem } from "../hosts/mirador/api.ts";

/**
 * A clock whose sleeps resolve when the test advances time: `runAll` keeps advancing to the next wake-up until nothing
 * sleeps, so a whole review plays in an instant and always the same way.
 */
export class FakeClock implements Clock {
  time = 1_000_000;
  private sleepers: { wake: number; resolve: () => void; reject: (reason: unknown) => void; signal: AbortSignal; onAbort: () => void }[] = [];

  now = () => this.time;

  sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const sleeper = { wake: this.time + ms, resolve, reject, signal, onAbort: () => {} };
      sleeper.onAbort = () => {
        this.sleepers = this.sleepers.filter((each) => each !== sleeper);
        reject(signal.reason);
      };
      signal.addEventListener("abort", sleeper.onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /** Lets pending promise callbacks run, so sleeps started after a wake-up are registered. */
  async settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Wakes the next sleeper(s); false when none sleeps. */
  async step(): Promise<boolean> {
    await this.settle();
    if (this.sleepers.length === 0) return false;
    const wake = Math.min(...this.sleepers.map((each) => each.wake));
    this.time = wake;
    const due = this.sleepers.filter((each) => each.wake <= wake);
    this.sleepers = this.sleepers.filter((each) => each.wake > wake);
    for (const each of due) {
      each.signal.removeEventListener("abort", each.onAbort);
      each.resolve();
    }
    await this.settle();
    return true;
  }

  async runAll(limit = 10_000) {
    for (let i = 0; i < limit; i++) if (!(await this.step())) return;
    throw new Error("The clock never went idle.");
  }
}

/** A stand-in for one Mirador conversation's canvas, with the plugin's items in it. */
export class FakeCanvas<Data> {
  items: PluginItem<Data>[] = [];
  prompts: string[] = [];
  /** The options each prompt was sent with, parallel to `prompts`. */
  promptOptions: unknown[] = [];
  storage = new Map<string, unknown>();
  /** What `profileSetting` returns, by setting id. */
  settings: Record<string, string | null> = {};
  /** The conversations `startConversation` was asked to start. */
  started: { profile: string; prompt: string; title?: string; model?: string; effort?: string }[] = [];
  /** The conversations `stopConversation` was asked to stop, in the order it was asked. */
  stopped: string[] = [];
  private next = 1;

  context(): CanvasToolContext<Data> & CanvasActionContext<Data> {
    return {
      conversationId: "conversation-1",
      items: () => this.items.map((item) => ({ ...item })),
      change: (itemId, change) => {
        const index = this.items.findIndex((item) => item.id === itemId);
        if (index < 0) throw new Error(`No item ${itemId}`);
        const item = { ...this.items[index]!, ...change };
        this.items[index] = item;
        return item;
      },
      storage: { get: (key) => this.storage.get(key), set: (key, value) => void (value === undefined ? this.storage.delete(key) : this.storage.set(key, value)) },
      profileSetting: (id) => this.settings[id] ?? null,
      publish: ({ type, title, data }) => {
        const item: PluginItem<Data> = { id: `item-${this.next++}`, type, title, data, createdAt: 0, dismissed: false, agentEditedAt: null };
        this.items.push(item);
        return item;
      },
      prompt: async (text, options) => {
        this.prompts.push(text);
        this.promptOptions.push(options);
      },
      startConversation: async (start) => {
        this.started.push(start);
        return { id: `conversation-fixer-${this.started.length}`, profile: start.profile };
      },
      stopConversation: async (conversationId) => {
        this.stopped.push(conversationId);
      },
    };
  }

  item(id: string) {
    const item = this.items.find((each) => each.id === id);
    if (!item) throw new Error(`No item ${id}`);
    return item;
  }
}

export const FILES = ["README.md", "docs/design.md", "package.json", "src/engine.ts", "src/server.ts", "src/store.ts", "tests/engine.test.ts", "tests/server.test.ts", "tsconfig.json"];
