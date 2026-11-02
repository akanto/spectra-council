/**
 * A stand-in for Mirador's canvas, to work on the view in a browser: it runs the real host module in-process, opens a
 * review on a target the way the agent's council_open would, and serves the built view with a `window.mirador` that
 * talks to the host over a WebSocket.
 *
 *   bun run harness [target] [--port 4830]
 *
 * Open http://127.0.0.1:4830 (add ?theme=dark for Mirador's dark colours). Each page load gets a fresh review.
 *
 * A stand-in agent answers "Ask agent to fix": it marks each finding it was asked about fixed, a second apart, with the
 * council's proposed fix as what it changed. Hand-offs are written to .harness/handoff/, not into the target.
 */
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Review } from "../core/model.ts";
import type { CanvasActionContext, CanvasToolContext, PluginItem } from "../hosts/mirador/api.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";

const repo = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args[portAt + 1]) : 4830;
const target = resolve(args.find((arg, index) => !arg.startsWith("--") && !(portAt >= 0 && index === portAt + 1)) ?? repo);

const handoffs = join(repo, ".harness", "handoff");
const host = createCouncilHost({
  writeFile: async (path, text) => {
    await mkdir(handoffs, { recursive: true });
    await Bun.write(join(handoffs, basename(path)), text);
    console.log(`[hand-off] ${path} → .harness/handoff/${basename(path)}`);
  },
});

/** The stand-in agent: fixes the findings a prompt names, one a second, through council_mark_fixed. */
async function standInAgent(canvas: Canvas, text: string) {
  console.log(`[to the agent] ${text}`);
  const asked = /most severe first: ([F\d, ]+)\./.exec(text)?.[1]?.split(/,\s*/) ?? [];
  for (const finding of asked) {
    await Bun.sleep(1000);
    const review = canvas.items.at(-1)?.data;
    const proposal = review?.findings.find(({ id }) => id === finding)?.proposal;
    try {
      await host.tools.council_mark_fixed!.run(
        { finding, summary: proposal ? `Applied the proposed fix: ${proposal.summary}` : "Applied the recommendation.", files: proposal?.files ?? [] },
        canvas.context(),
      );
    } catch (error) {
      console.error(`[stand-in agent] ${finding}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** Item ids are unique across pages, as Mirador's are across conversations: the host keys its running reviews by them. */
let nextItem = 1;

/** The plugin's storage, shared by the pages: profiles "seated before", so the setup offers them. */
const storage = new Map<string, unknown>([["seatedProfiles", ["Home", "pi home"]]]);

/** One page's canvas: its items, and the socket to tell about each change. */
class Canvas {
  items: PluginItem<Review>[] = [];
  socket: Bun.ServerWebSocket<{ canvas: Canvas }> | null = null;

  private push(item: PluginItem<Review>) {
    this.socket?.send(JSON.stringify({ kind: "item", item }));
  }

  context(): CanvasToolContext<Review> & CanvasActionContext<Review> {
    return {
      conversationId: "harness",
      items: () => [...this.items],
      change: (itemId, change) => {
        const index = this.items.findIndex((item) => item.id === itemId);
        if (index < 0) throw new Error(`No item ${itemId}`);
        const item = { ...this.items[index]!, ...change };
        this.items[index] = item;
        this.push(item);
        return item;
      },
      storage: { get: (key) => storage.get(key), set: (key, value) => void storage.set(key, value) },
      profileSetting: () => null,
      publish: ({ type, title, data }) => {
        const item: PluginItem<Review> = { id: `item-${nextItem++}`, type, title, data, createdAt: Date.now(), dismissed: false, agentEditedAt: null };
        this.items.push(item);
        this.push(item);
        return item;
      },
      prompt: async (text) => {
        void standInAgent(this, text);
      },
      startConversation: async () => {
        throw new Error("The harness has no Mirador profiles; seat mocks here.");
      },
    };
  }
}

const DARK = {
  "--mirador-panel": "#1c1d20",
  "--mirador-panel-2": "#26282c",
  "--mirador-border": "#34363b",
  "--mirador-text": "#e6e6e3",
  "--mirador-muted": "#9da0a6",
  "--mirador-faint": "#6d7077",
  "--mirador-accent": "#7aa2f7",
  "--mirador-ok": "#5fbf77",
  "--mirador-warn": "#e3954f",
  "--mirador-danger": "#ef6b5f",
  "--mirador-code-bg": "#232428",
};

const page = (dark: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Spectra Council harness</title>
<style>${dark ? `:root{color-scheme:dark;${Object.entries(DARK).map(([name, value]) => `${name}:${value}`).join(";")}}` : ":root{color-scheme:light}"}</style>
<script>
(() => {
  const socket = new WebSocket("ws://" + location.host + "/socket");
  const listeners = new Set();
  const waiting = new Map();
  let latest = null, next = 1;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.kind === "item") { latest = message.item; for (const listener of listeners) listener(latest, { seenAgentEditAt: null, imagesFromOtherSites: false }); }
    if (message.kind === "reply") { const w = waiting.get(message.requestId); waiting.delete(message.requestId); message.problem ? w.reject(new Error(message.problem)) : w.resolve(message.reply); }
  };
  const ready = new Promise((resolve) => (socket.onopen = resolve));
  window.mirador = {
    onItem(listener) { listeners.add(listener); if (latest) listener(latest, { seenAgentEditAt: null, imagesFromOtherSites: false }); return () => listeners.delete(listener); },
    async send(action) { await ready; const requestId = next++; return new Promise((resolve, reject) => { waiting.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ requestId, action })); }); },
    async prompt(text) { console.log("[prompt]", text); },
    setFullscreen() {},
    openFile(path) { console.log("[open file]", path); document.title = "open " + path; },
  };
})();
</script></head><body><script type="module" src="/view.js"></script></body></html>`;

Bun.serve<{ canvas: Canvas }>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/socket") {
      if (server.upgrade(request, { data: { canvas: new Canvas() } })) return undefined;
      return new Response("Expected a WebSocket", { status: 400 });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/view.js") return new Response(Bun.file(join(repo, "dist", "view.js")), { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/") return new Response(page(url.searchParams.get("theme") === "dark"), { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    async open(socket) {
      const canvas = socket.data.canvas;
      canvas.socket = socket;
      await host.tools.council_open!.run({ target, profile: "architecture", agents: ["mock-codex", "mock-claude", "mock-gemini", "mock-qwen"] }, canvas.context());
    },
    // A closed page stops its review, as nothing will show it any more.
    async close(socket) {
      const canvas = socket.data.canvas;
      canvas.socket = null;
      for (const item of canvas.items) await Promise.resolve(host.action!(item, { kind: "stop" }, canvas.context())).catch(() => {});
    },
    async message(socket, raw) {
      const { requestId, action } = JSON.parse(String(raw)) as { requestId: number; action: unknown };
      const canvas = socket.data.canvas;
      const item = canvas.items.at(-1)!;
      try {
        const reply = await host.action!(item, action, canvas.context());
        socket.send(JSON.stringify({ kind: "reply", requestId, reply: reply ?? null }));
      } catch (error) {
        socket.send(JSON.stringify({ kind: "reply", requestId, problem: error instanceof Error ? error.message : String(error) }));
      }
    },
  },
});

console.log(`Spectra Council harness on http://127.0.0.1:${port}, reviewing ${target}`);
