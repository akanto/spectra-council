/**
 * The built view (dist/view.js) in a real browser, around the real host: setup renders, a review on mock seats runs to
 * its verdict, the Council and Findings tabs open, and nothing throws. Twice: in Chrome as a plain page, and in WebKit
 * (the engine of Mirador's app) framed as Mirador frames plugin items, where every error the frame reports fails the run.
 * Chrome and WebKit come from the machine (playwright-core downloads none: `bunx playwright-core install webkit`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type FrameLocator, type Page } from "playwright-core";
import { MIRADOR_CANVAS, startHarness, type Harness } from "./harness.ts";

const repo = join(import.meta.dir, "..");
const shots = join(repo, ".harness", "e2e");
const chrome = process.platform === "darwin" ? "/Applications/Google Chrome.app" : "/usr/bin/google-chrome";
const built = existsSync(join(repo, "dist", "view.js"));

const setups = [
  { name: "in Chrome", slug: "chrome", run: existsSync(chrome) && built, launch: () => chromium.launch({ channel: "chrome" }), mirador: false },
  { name: "in WebKit, framed as Mirador frames it", slug: "webkit", run: existsSync(webkit.executablePath()) && existsSync(MIRADOR_CANVAS) && built, launch: () => webkit.launch(), mirador: true },
];

// In CI (or with E2E_REQUIRED, or MIRADOR_CANVAS set), a setup that can't run fails instead of skipping silently.
const required = Boolean(process.env.CI || process.env.E2E_REQUIRED || process.env.MIRADOR_CANVAS);
for (const setup of setups) {
  if (required && !setup.run) test(`the view ${setup.name} can run`, () => {
    throw new Error(`Can't run the e2e ${setup.name}: needs dist/view.js, ${setup.mirador ? `WebKit (bunx playwright-core install webkit) and Mirador's canvas code at ${MIRADOR_CANVAS}` : `Chrome at ${chrome}`}.`);
  });
}

for (const setup of setups) describe.skipIf(!setup.run)(`the view ${setup.name}`, () => {
  let harness: Harness;
  let browser: Browser;
  let page: Page;
  let root: Page | FrameLocator;
  const errors: string[] = [];
  const shot = (step: string) => page.screenshot({ path: join(shots, `${setup.slug}-${step}.png`), fullPage: true });

  beforeAll(async () => {
    await mkdir(shots, { recursive: true });
    harness = await startHarness(null, { mirador: setup.mirador });
    browser = await setup.launch();
    page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => (message.type() === "error" || message.text().startsWith("FRAME ERROR: ")) && errors.push(message.text()));
    await page.goto(harness.url);
    root = setup.mirador ? page.frameLocator("iframe") : page;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await harness?.stop();
  });

  test("setup renders", async () => {
    await root.getByText("Start review").waitFor({ timeout: 30_000 });
    await shot("1-setup");
  }, 40_000);

  test("a review on mock seats runs to its verdict", async () => {
    await root.getByText("Start review").click();
    await root.locator(".pill.phase-independent-review").waitFor({ timeout: 30_000 });
    await shot("2-running");
    await root.locator(".pill.phase-complete").waitFor({ timeout: 240_000 });
    await root.locator(".verdict").first().waitFor({ timeout: 10_000 });
    await shot("3-verdict");
  }, 270_000);

  test("the Council and Findings tabs open", async () => {
    await root.getByRole("tab", { name: /Council/ }).click();
    await root.locator(".council-item").first().waitFor({ timeout: 10_000 });
    await root.locator(".council-item").first().click();
    await shot("4-council");
    await root.getByRole("tab", { name: /Findings/ }).click();
    await root.locator(".finding-card .finding-row").first().waitFor({ timeout: 10_000 });
    await root.locator(".finding-card .finding-row").first().click();
    await shot("5-findings");
  }, 40_000);

  test("nothing threw", () => {
    expect(errors).toEqual([]);
  });
});
