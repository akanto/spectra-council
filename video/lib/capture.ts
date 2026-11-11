/**
 * Films Spectra Council in a real Mirador: a throwaway host from the Mirador checkout (its e2e TestHost) on the owner's
 * Claude login, with a build of this plugin linked in whose reviewers play script.ts (plugin-host.ts). A person asks the
 * agent for a review of the demo shop in ~/code/tinyshop, starts it, watches the council, rules, and has the agent fix
 * what was accepted (a real Claude turn), then has the council re-check the fixes. Frames come from Chrome's
 * screencast; the moments that matter go to video/out/capture/moments.json for the edit. `bun video/lib/capture.ts`
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Frame, type Locator } from "playwright-core";
import { TestHost } from "../../../../sodre90/mirador/e2e/test-host.ts";
import { Cursor } from "./cursor.ts";
import { typeLikeAPerson } from "./typing.ts";

const repo = join(import.meta.dir, "..", "..");
const out = join(import.meta.dir, "..", "out", "capture");
const framesDir = join(out, "frames");
rmSync(out, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

/** The app at a laptop's size, drawn at 5/3 so frames are 2560 x 1440, made 1080p in the edit. */
const FRAME = { cssWidth: 1536, cssHeight: 864, scale: 5 / 3 };
const width = Math.round(FRAME.cssWidth * FRAME.scale);
const height = Math.round(FRAME.cssHeight * FRAME.scale);

// The demo shop, in a folder the sidebar shows as ~/code/tinyshop, with the agent allowed what the take needs.
const shop = join(homedir(), "code", "tinyshop");
/** Marks the folder as the take's own, so a take only ever replaces a copy an earlier take made. */
const MARKER = ".spectra-council-video";
if (existsSync(shop) && !existsSync(join(shop, MARKER))) throw new Error(`${shop} exists and isn't a copy this script made; move it away first.`);
rmSync(shop, { recursive: true, force: true });
cpSync(join(import.meta.dir, "..", "demo", "tinyshop"), shop, { recursive: true });
writeFileSync(join(shop, MARKER), "The promo video's copy of video/demo/tinyshop; capture.ts replaces it on each take.\n");
mkdirSync(join(shop, ".claude"), { recursive: true });
writeFileSync(join(shop, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__canvas", "Read", "Edit", "Write", "Bash"] } }, null, 2));

const host = new TestHost({ usesClaudeLogin: true, environment: { MIRADOR_TEST_MODEL: "sonnet", MIRADOR_TEST_EFFORT: "medium" } });
// The plugin folder: the real manifest and view, with the video's host.
const plugin = join(host.dataDir, "plugins", "spectra-council");
mkdirSync(join(plugin, "dist"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(repo, "plugin.json"), "utf8"));
delete manifest.build;
manifest.canvas.host = "host.ts";
writeFileSync(join(plugin, "plugin.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(plugin, "host.ts"), `export { default } from ${JSON.stringify(join(repo, "video", "lib", "plugin-host.ts"))};\n`);
cpSync(join(repo, "dist", "view.js"), join(plugin, "dist", "view.js"));
await host.start();
console.log("host on", host.authUrl);
// The canvas "as needed", as most people have it: with "often" Mirador follows a long reply after a page with a note.
const state = new Database(join(host.dataDir, "state.sqlite"));
state.query("INSERT INTO settings (key, value) VALUES ('canvas_use', 'as-needed') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
state.close();

const profile = mkdtempSync(join(tmpdir(), "council-video-chrome-"));
mkdirSync(join(profile, "Default"));
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(FRAME.scale) / Math.log(1.2) } } }));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width, height },
  deviceScaleFactor: 1,
  args: [`--window-size=${width},${height}`, `--screen-info={${width}x${height}}`, "--hide-scrollbars"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.addInitScript(() => {
  if (window.top !== window) return;
  localStorage.setItem("mirador-theme", "dark");
  localStorage.setItem("mirador-sidebar-width", "200");
});
const cursor = new Cursor(page as never, { x: FRAME.cssWidth * 0.6, y: FRAME.cssHeight * 0.7 });
await cursor.install();

const moments: { name: string; at: number }[] = [];
const mark = (name: string) => {
  moments.push({ name, at: Date.now() / 1000 });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
};
const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });

// Off camera: sign in, add the shop's folder, start a conversation.
await page.goto(host.authUrl);
await page.getByText("No conversation selected").or(page.getByRole("heading", { name: "Set up a profile to start" })).waitFor({ timeout: 60_000 });
await page.getByRole("button", { name: "Add workspace" }).click();
await page.getByLabel("Workspace directory").fill(shop);
await page.getByLabel("Workspace directory").press("Enter");
const card = page.locator(".workspace", { has: page.locator(`.workspace-heading[title="${shop}"]`) });
await card.waitFor({ timeout: 30_000 });
await card.getByRole("button", { name: "+ New conversation" }).click();
await page.locator(".chat-header:visible .conversation-settings-toggle").waitFor({ timeout: 90_000 });
await page.locator(".composer:visible .send").waitFor({ timeout: 90_000 });
// A narrow chat and a wide canvas: the council is the star.
const divider = page.getByRole("separator", { name: "Resize the left and right panes" });
await divider.focus();
for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
await page.mouse.click(5, 5);
await page.waitForTimeout(1500);
await shot("start");

// Filming.
const frames: { t: number; file: string }[] = [];
const cdp = await context.newCDPSession(page);
let pending = Promise.resolve();
/** At most 24 frames a second, enough for the edit, which speeds the waits up anyway. */
const FPS = 24;
let stopped = false;
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (stopped || (frames.length && metadata.timestamp! - frames.at(-1)!.t < 1 / FPS - 0.002)) return;
  if (frames.length > 30_000) {
    stopped = true;
    console.error("Over 30000 frames: the take is stuck; stopping it.");
    return;
  }
  const file = join(framesDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
  frames.push({ t: metadata.timestamp!, file });
  pending = pending.then(() => writeFile(file, Buffer.from(data, "base64")));
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
mark("start");

const composer = page.locator(".composer:visible textarea");

async function send(name: string, text: string) {
  await page.locator(".composer:visible .send").waitFor({ timeout: 120_000 });
  await cursor.click(composer);
  mark(`${name} typing`);
  await typeLikeAPerson(page as never, text);
  await page.waitForTimeout(500);
  mark(`${name} sent`);
  await composer.press("Enter");
}

/** Waits for the agent's turn to end, answering any permission question with Allow so the take goes on. */
async function turnEnds(name: string) {
  const badge = async () => (await page.locator(".chat-header:visible .badge").textContent())?.trim();
  for (let i = 0; i < 120 && (await badge()) === "idle"; i++) await page.waitForTimeout(250);
  mark(`${name} working`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (stopped) throw new Error("the take ran too long");
    if ((await badge()) === "idle") break;
    const always = page.getByRole("button", { name: /^Yes, and don.t ask again/ }).first();
    const once = page.getByRole("button", { name: "Yes", exact: true }).first();
    for (const allow of [always, once]) {
      if (!(await allow.isVisible().catch(() => false))) continue;
      mark(`${name} asked permission`);
      await page.waitForTimeout(900);
      await cursor.click(allow as never);
      break;
    }
    await page.waitForTimeout(500);
  }
  mark(`${name} done`);
}

/** The frame the council's view runs in, inside the canvas's frames. */
async function council(): Promise<Frame> {
  for (let i = 0; i < 240; i++) {
    for (const frame of page.frames()) if (await frame.locator(".pill").first().isVisible().catch(() => false)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("Spectra Council's view never showed");
}

const click = async (target: Locator, options?: { offsetX?: number; offsetY?: number }) => cursor.click(target as never, options);
const phase = (view: Frame, name: string, timeout = 300_000) => view.locator(`.pill.phase-${name}`).first().waitFor({ timeout });

try {
  await page.waitForTimeout(1500);
  await send("open", "Convene a Spectra Council code review of this repo.");
  await turnEnds("open");
  const view = await council();
  await view.getByText("Start review").waitFor({ timeout: 60_000 });
  mark("setup");
  await page.waitForTimeout(3000);
  // Any of the four the agent didn't seat, the person adds.
  for (const name of ["Claude", "Codex", "Gemini", "Qwen"]) {
    const seated = await view.locator(".seats .seat select.seat-agent").evaluateAll((selects, name) => selects.some((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent?.endsWith(`— ${name}`)), name);
    if (seated) continue;
    await click(view.getByRole("button", { name: /Add reviewer/ }));
    const seat = view.locator(".seats .seat select.seat-agent").last();
    await page.waitForTimeout(400);
    const value = await seat.evaluate((select, name) => [...(select as HTMLSelectElement).options].find((option) => option.textContent?.endsWith(`— ${name}`))?.value, name);
    if (value) await seat.selectOption(value);
    await page.waitForTimeout(600);
  }
  mark("seated");
  await page.waitForTimeout(1500);
  await shot("setup");

  await click(view.getByRole("button", { name: "Start review" }));
  mark("started");
  await phase(view, "independent-review");
  await view.locator(".finding-row, .seat-panel .finding, .council-item").first().waitFor({ timeout: 60_000 }).catch(() => {});
  mark("first finding");
  await phase(view, "deliberation");
  mark("deliberation");
  await page.waitForTimeout(2500);
  await shot("deliberation");
  await view.getByRole("tab", { name: /Council/ }).click().catch(() => {});
  // The challenge to the oversell race, its answer and the concession, as they come in.
  await page.waitForTimeout(3500);
  await click(view.locator(".council-item", { hasText: "Two buyers can both get the last item" }));
  mark("race");
  await page.waitForTimeout(1000);
  mark("race arguments");
  // Follow the thread as it grows, as a person reading it would: the newest argument kept in view.
  await view.evaluate(() => {
    const started = Date.now();
    const follow = setInterval(() => {
      const thread = [...document.querySelectorAll(".detail .argument, .argument")];
      thread.at(-1)?.scrollIntoView({ block: "end", behavior: "smooth" });
      if (Date.now() - started > 16_000 || document.querySelector(".pill.phase-complete")) clearInterval(follow);
    }, 900);
  });
  await page.waitForTimeout(9000);
  await shot("race");
  await phase(view, "complete");
  await view.locator(".verdict").first().evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "smooth" });
  }).catch(() => {});
  mark("verdict");
  await page.waitForTimeout(2500);
  await click(view.locator(".council-item", { hasText: "Checkout can charge an outdated price" }));
  mark("disputed");
  await page.waitForTimeout(5500);
  await shot("disputed");

  // Rulings: the four that stand unchallenged accepted at once, the disputed one for later.
  mark("ruling");
  await view.locator(".verdict").first().evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  await page.waitForTimeout(900);
  await click(view.getByRole("button", { name: /Accept all agreed/ }));
  await page.waitForTimeout(1200);
  await click(view.locator(".council-item", { hasText: "Checkout can charge an outdated price" }));
  await page.waitForTimeout(700);
  await click(view.locator(".ruling .segmented button", { hasText: "Later" }));
  await page.waitForTimeout(1200);
  await shot("ruled");

  await click(view.getByRole("button", { name: /Ask .* to fix/ }));
  mark("fix asked");
  await turnEnds("fix");
  await page.waitForTimeout(2500);
  await shot("fixed");

  // The agent's edits put the canvas on its changes; the review is back from History.
  let again = view;
  if (!(await view.locator(".pill").first().isVisible().catch(() => false))) {
    await click(page.getByRole("button", { name: /^History/ }));
    await page.waitForTimeout(700);
    await click(page.locator(".canvas-history .history-entry", { hasText: "tinyshop" }).last());
    again = await council();
    await page.waitForTimeout(1500);
  }
  // A review opened again starts on its Workspace tab; the fixes are re-checked from the Council's action plan.
  await again.getByRole("tab", { name: /Council/ }).click().catch(() => {});
  await page.waitForTimeout(800);
  mark("review back");
  await click(again.getByRole("button", { name: /Re-check fixes/ }));
  mark("recheck");
  await phase(again, "verification", 60_000).catch(() => {});
  await phase(again, "complete");
  mark("rechecked");
  await page.waitForTimeout(1500);
  await click(again.locator(".council-item", { hasText: "Two buyers can both get the last item" }));
  await page.waitForTimeout(4000);
  await shot("rechecked");
  mark("end");
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await pending;
  writeFileSync(join(out, "frames.json"), JSON.stringify(frames.map(({ t, file }) => ({ t, file: file.split("/").at(-1) }))));
  writeFileSync(join(out, "moments.json"), JSON.stringify(moments, null, 2));
  console.log(`${frames.length} frames`);
  await context.close();
  await host.stop();
  await host.cleanUp();
  rmSync(profile, { recursive: true, force: true });
}
