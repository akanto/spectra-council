/**
 * A harness for the end-to-end test: it runs the real host (createCouncilHost) in-process, opens a review of a small
 * fixture folder on mock seats as council_open does, and serves the built view (dist/view.js) either as a plain page
 * (a `window.mirador` bridge over HTTP) or framed as Mirador frames plugin items (Mirador's own canvas code, where it is
 * installed): a sandboxed frame from another origin with Mirador's shell, Content-Security-Policy and bridge.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Review } from "../core/model.ts";
import type { CanvasActionContext, CanvasToolContext, PluginItem } from "../hosts/mirador/api.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { FILES } from "../tests/support.ts";

export interface Harness {
  url: string;
  /** The fixture folder under review. */
  target: string;
  review(): Review;
  setReview(review: Review): void;
  restartHost(): void;
  prompts: string[];
  stop(): Promise<void>;
}

/**
 * Mirador's own canvas code: MIRADOR_CANVAS names the file; else the pinned checkout CI makes (.mirador/shared), else
 * the installed app's.
 */
export const MIRADOR_CANVAS =
  process.env.MIRADOR_CANVAS ??
  [join(import.meta.dir, "..", ".mirador", "shared", "canvas-document.ts"), join(homedir(), "Applications/Mirador.app/Contents/Resources/app/mirador/shared/canvas-document.ts")].find((path) => existsSync(path)) ??
  join(homedir(), "Applications/Mirador.app/Contents/Resources/app/mirador/shared/canvas-document.ts");

/** The parts of Mirador's canvas-document.ts the harness uses (typed here, so typechecking doesn't read Mirador's code). */
interface MiradorCanvas {
  CANVAS_SHELL_PAGE: string;
  canvasShellPolicy(assetsOrigins: string[]): string;
  pluginItemPage(viewUrl: string, frameId: string, options?: { inTab?: boolean; opensFiles?: boolean }): string;
  buildCanvasDocument(html: string, itemId: string, assetsOrigin: string, theme: "light" | "dark"): string;
}

const CONTEXT = { seenAgentEditAt: null, imagesFromOtherSites: false };

/** A plain page's `window.mirador`: the item by long polling, actions by POST. */
const BRIDGE = `
(() => {
  const listeners = new Set();
  let latest;
  (async () => {
    let seen = -1;
    for (;;) {
      const response = await fetch("/item?after=" + seen).catch(() => null);
      if (!response) { await new Promise((r) => setTimeout(r, 500)); continue; }
      const { version, item } = await response.json();
      seen = version;
      latest = item;
      listeners.forEach((l) => l(item, ${JSON.stringify(CONTEXT)}));
    }
  })();
  window.__prompts = [];
  window.__openedPaths = [];
  window.mirador = {
    place: "canvas",
    onItem(listener) { listeners.add(listener); if (latest) listener(latest, ${JSON.stringify(CONTEXT)}); return () => listeners.delete(listener); },
    async send(action) {
      const response = await fetch("/action", { method: "POST", body: JSON.stringify(action) });
      const { reply, problem } = await response.json();
      if (problem) throw new Error(problem);
      return reply;
    },
    async prompt(text) { window.__prompts.push(text); },
    startConversation: () => Promise.reject(new Error("no")),
    addToComposer: () => Promise.reject(new Error("no")),
    openLink() {},
    setFullscreen() {},
    openFile(path) { window.__openedPaths.push(path); },
  };
})();`;

/**
 * The page that frames the view as Mirador's panel does, relaying the frame's messages to the server. The frame's errors
 * are logged as "FRAME ERROR: …" and kept in `window.__frameErrors`.
 */
function miradorParentPage(canvas: MiradorCanvas, assets: string) {
  const frameId = "plugin:test/council";
  const page = canvas.buildCanvasDocument(canvas.pluginItemPage(`${assets}/view.js`, frameId, { opensFiles: true }), frameId, assets, "light");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe sandbox="allow-scripts" src="${assets}/canvas-shell.html"></iframe>
<script>
  const frame = document.querySelector("iframe");
  const page = ${JSON.stringify(page).replace(/</g, "\\u003c")};
  const source = "mirador-canvas";
  const post = (message) => frame.contentWindow.postMessage({ source, ...message }, "*");
  window.__frameErrors = [];
  window.__prompts = [];
  window.__openedPaths = [];
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    let seen = -1;
    for (;;) {
      const { version, item } = await (await fetch("/item?after=" + seen)).json();
      seen = version;
      post({ kind: "item-state", item, context: ${JSON.stringify(CONTEXT)} });
    }
  };
  addEventListener("message", async (event) => {
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || m.source !== source) return;
    if (m.kind === "shell-ready") post({ kind: "page", document: page });
    if (m.kind === "error") { window.__frameErrors.push(m.message); console.log("FRAME ERROR: " + m.message); }
    if (m.kind === "item-ready") poll();
    if (m.kind === "item-send") {
      const { reply, problem } = await (await fetch("/action", { method: "POST", body: JSON.stringify(m.action) })).json();
      post(problem ? { kind: "item-reply-failed", requestId: m.requestId, message: problem } : { kind: "item-reply", requestId: m.requestId, reply });
    }
    if (m.kind === "item-open-file") window.__openedPaths.push(m.path);
    if (m.kind === "item-prompt") { window.__prompts.push(m.text); post({ kind: "item-reply", requestId: m.requestId, reply: null }); }
  });
</script>`;
}

export async function startHarness(sourceTarget: string | null, { mirador }: { mirador: boolean }): Promise<Harness> {
  const canvas = mirador ? ((await import(MIRADOR_CANVAS)) as MiradorCanvas) : null;
  const target = sourceTarget ?? (await mkdtemp(join(tmpdir(), "council-e2e-")));
  if (!sourceTarget) {
    for (const file of FILES) {
      await mkdir(dirname(join(target, file)), { recursive: true });
      await writeFile(join(target, file), `// ${file}\nexport const name = ${JSON.stringify(file)};\n`);
    }
  }
  let host = createCouncilHost({ writeFile: async () => {} });
  const view = Bun.file(join(import.meta.dir, "..", "dist", "view.js"));

  let item: PluginItem<Review> | null = null;
  const items: PluginItem<Review>[] = [];
  let version = 0;
  let waiting: (() => void)[] = [];
  const changed = () => {
    version++;
    waiting.forEach((wake) => wake());
    waiting = [];
  };
  const prompts: string[] = [];
  const storage = new Map<string, unknown>();
  const context: CanvasToolContext<Review> & CanvasActionContext<Review> = {
    conversationId: "e2e",
    items: () => [...items],
    change: (itemId, change) => {
      const index = items.findIndex((each) => each.id === itemId);
      if (index < 0) throw new Error(`No item ${itemId}`);
      item = { ...items[index]!, ...change };
      items[index] = item;
      changed();
      return item;
    },
    storage: { get: (key) => storage.get(key), set: (key, value) => void storage.set(key, value) },
    profileSetting: () => null,
    publish: ({ type, title, data }) => {
      item = { id: "item-1", type, title, data, createdAt: Date.now(), dismissed: false, agentEditedAt: null };
      items.push(item);
      changed();
      return item;
    },
    prompt: async (text) => { prompts.push(text); },
    startConversation: async () => {
      throw new Error("The e2e harness has no Mirador profiles; seats are mocks.");
    },
  };
  await host.tools.council_open!.run({ target, profile: "general", depth: "quick", agents: ["mock-codex", "mock-claude"] }, context);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      // The frame's origin ("localhost") differs from the page's ("127.0.0.1"), as Mirador's assets origin does.
      const assets = `http://localhost:${server.port}`;
      if (url.pathname === "/" && canvas) return new Response(miradorParentPage(canvas, assets), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/canvas-shell.html" && canvas) {
        return new Response(canvas.CANVAS_SHELL_PAGE, { headers: { "content-type": "text/html", "content-security-policy": canvas.canvasShellPolicy([assets]), "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/") return new Response(`<!doctype html><meta charset="utf-8"><script>${BRIDGE}</script><script type="module" src="/view.js"></script>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/view.js") return new Response(view, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname === "/item") {
        if (Number(url.searchParams.get("after")) >= version) await new Promise<void>((wake) => waiting.push(wake));
        return Response.json({ version, item });
      }
      if (url.pathname === "/action" && request.method === "POST") {
        try {
          const reply = await host.action!(item!, await request.json(), context);
          return Response.json({ reply: reply ?? null });
        } catch (error) {
          return Response.json({ problem: error instanceof Error ? error.message : String(error) });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    target,
    review: () => item!.data,
    setReview: (review) => { context.change(item!.id, { data: review }); },
    restartHost: () => { host = createCouncilHost({ writeFile: async () => {} }); },
    prompts,
    async stop() {
      if (item) await Promise.resolve(host.action!(item, { kind: "stop" }, context)).catch(() => {});
      await server.stop(true);
      if (!sourceTarget) await rm(target, { recursive: true, force: true });
    },
  };
}
