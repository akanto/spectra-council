/**
 * Drives the harness in Chrome through a review and screenshots each view into .harness/: setup, the workspace while it
 * runs, a reviewer's activity, the council's deliberation, the verdict and the findings, in the light and the dark theme,
 * at about the width the canvas has beside the chat. Start the harness first.
 *
 *   bun scripts/screenshots.ts [http://127.0.0.1:4830]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:4830";
const out = join(import.meta.dir, "..", ".harness");
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const errors: string[] = [];

async function tour(theme: "light" | "dark") {
  // About the width the canvas has beside the chat.
  const page: Page = await browser.newPage({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && errors.push(`${theme}: ${message.text()}`));
  const shot = (name: string) => page.screenshot({ path: join(out, `${theme}-${name}.png`), fullPage: true });

  await page.goto(`${base}/?theme=${theme}`);
  await page.getByText("Start review").waitFor();
  await page.locator(".seat-toggle input").nth(2).check();
  await page.locator(".seat-toggle input").nth(3).check();
  await page.waitForTimeout(300);
  await shot("1-setup");

  await page.getByText("Start review").click();
  await page.locator(".pill.phase-independent-review").waitFor();
  await page.waitForTimeout(7000);
  await shot("2-running");

  await page.locator(".seat-panel").first().click();
  await page.waitForTimeout(400);
  await shot("3-reviewer");
  await page.locator(".detail .icon-button").click();

  await page.locator(".pill.phase-deliberation").waitFor({ timeout: 120_000 });
  await page.waitForTimeout(12_000);
  await page.getByRole("tab", { name: /Council/ }).click();
  await page.waitForTimeout(300);
  await shot("4-deliberation");

  await page.locator(".pill.phase-complete").waitFor({ timeout: 180_000 });
  await page.waitForTimeout(500);
  await shot("5-verdict");

  await page.getByRole("tab", { name: /Workspace/ }).click();
  await page.waitForTimeout(300);
  await shot("6-workspace-complete");

  await page.getByRole("tab", { name: /Findings/ }).click();
  await page.locator(".finding-card .finding-row").first().click();
  await page.waitForTimeout(300);
  await shot("7-findings");
  await page.close();
}

await tour("light");
await tour("dark");
await browser.close();
console.log(errors.length ? `Errors:\n${errors.join("\n")}` : "No errors in the page.");
console.log(`Screenshots in ${out}`);
