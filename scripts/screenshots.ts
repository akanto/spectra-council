/**
 * Drives the harness in Chrome through a review and screenshots each view into .harness/: setup, the workspace while it
 * runs, a reviewer's activity, the council's deliberation, the verdict, rulings, the fixes and their re-check, and the
 * findings, in the light and the dark theme,
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

  // Rule on the findings that stand (withdrawn ones need no ruling): dismiss the last, defer the one before, accept
  // the rest.
  const items = page.locator(".council-item");
  const standing = items.filter({ hasNotText: "Withdrawn" });
  const decide = async (index: number, label: string) => {
    await standing.nth(index).click();
    await page.locator(".ruling .segmented button", { hasText: label }).click();
    await page.waitForTimeout(250);
  };
  const count = await standing.count();
  for (let index = 0; index < count; index++) await decide(index, index === count - 1 && count > 2 ? "Dismiss" : index === count - 2 && count > 3 ? "Later" : "Accept");
  await items.nth(0).click();
  await page.waitForTimeout(300);
  await shot("6-ruling");

  await page.getByRole("button", { name: /Write hand-off/ }).click();
  await page.locator(".handoff-path").waitFor();
  await page.getByRole("button", { name: /Ask agent to fix/ }).click();
  // The harness's stand-in agent marks one fix a second.
  await page.waitForFunction(() => document.querySelector(".fix-handed-off")?.textContent?.startsWith("0 ") ?? false, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
  await shot("7-fixed");

  await page.getByRole("button", { name: /Re-check fixes/ }).click();
  await page.locator(".pill.phase-verification").waitFor();
  await page.waitForTimeout(1500);
  await page.getByRole("tab", { name: /Workspace/ }).click();
  await shot("8-rechecking");
  await page.locator(".pill.phase-complete").waitFor({ timeout: 120_000 });
  await page.waitForTimeout(500);
  await shot("9-workspace-after");

  await page.getByRole("tab", { name: /Council/ }).click();
  await items.nth(0).click();
  await page.waitForTimeout(300);
  await shot("10-council-after");

  await page.getByRole("tab", { name: /Findings/ }).click();
  await page.locator(".finding-card .finding-row").first().click();
  await page.waitForTimeout(300);
  await shot("11-findings");
  await page.close();
}

await tour("light");
await tour("dark");
await browser.close();
console.log(errors.length ? `Errors:\n${errors.join("\n")}` : "No errors in the page.");
console.log(`Screenshots in ${out}`);
