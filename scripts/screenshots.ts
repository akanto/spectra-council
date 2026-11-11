/**
 * Drives the harness in Chrome through a review and screenshots each view into .harness/: setup, the workspace while it
 * runs, a reviewer's activity, the council's deliberation, the verdict, rulings, the fixes and their re-check, and the
 * findings, in the light and the dark theme,
 * at about the width the canvas has beside the chat; the dark tour also takes the plugin catalog's pictures into
 * screenshots/. Start the harness first.
 *
 *   bun scripts/screenshots.ts [http://127.0.0.1:4830]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:4830";
const out = join(import.meta.dir, "..", ".harness");
await mkdir(out, { recursive: true });
// The plugin catalog's pictures: the dark tour also takes these, at the catalog's 1440x900, into screenshots/.
const catalogOut = join(import.meta.dir, "..", "screenshots");
await mkdir(catalogOut, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const errors: string[] = [];

async function tour(theme: "light" | "dark") {
  // About the width the canvas has beside the chat.
  const page: Page = await browser.newPage({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(`${theme}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && errors.push(`${theme}: ${message.text()}`));
  const shot = (name: string) => page.screenshot({ path: join(out, `${theme}-${name}.png`), fullPage: true });
  /** `top`: the element to start the picture at; else the page's top. */
  const catalogShot = async (name: string, top?: string) => {
    if (theme !== "dark") return;
    await page.setViewportSize({ width: 1440, height: 900 });
    // The catalog's pictures name the seats as a review on real profiles does: no "(mock)", no mock chip. An observer
    // keeps the live view's re-renders from bringing them back before the picture is taken.
    await page.evaluate(() => {
      const strip = (root: Node) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue?.includes(" (mock)")) node.nodeValue = node.nodeValue.replaceAll(" (mock)", "");
      };
      strip(document.body);
      const observer = new MutationObserver((changes) => { for (const change of changes) strip(change.target); });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      (window as unknown as { catalogObserver?: MutationObserver }).catalogObserver = observer;
      document.head.insertAdjacentHTML("beforeend", '<style id="catalog-style">.chip.mock { display: none !important; }</style>');
    });
    await page.waitForTimeout(300);
    await page.evaluate((selector) => {
      const element = selector ? document.querySelector(selector) : null;
      window.scrollTo(0, element ? element.getBoundingClientRect().top + window.scrollY - 16 : 0);
    }, top ?? null);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(catalogOut, `${name}.png`) });
    await page.evaluate(() => {
      (window as unknown as { catalogObserver?: MutationObserver }).catalogObserver?.disconnect();
      document.getElementById("catalog-style")?.remove();
    });
    await page.setViewportSize({ width: 960, height: 900 });
  };

  await page.goto(`${base}/?theme=${theme}`);
  await page.getByText("Start review").waitFor();
  // Four mock reviewers: the harness starts with two; "Add reviewer" offers its stand-in profiles first, which can't run
  // there, so the added seats are switched to mocks.
  const extra = ["mock-gemini", "mock-qwen"];
  for (let seat = await page.locator(".seats .seat").count(); seat < 4; seat++) {
    await page.getByRole("button", { name: /Add reviewer/ }).click();
    await page.locator(".seats .seat").nth(seat).waitFor();
    await page.locator(".seats .seat select.seat-agent").nth(seat).selectOption(extra[seat - 2] ?? "mock-qwen");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(300);
  await shot("1-setup");

  await page.getByText("Start review").click();
  await page.locator(".pill.phase-independent-review").waitFor();
  await page.waitForTimeout(7000);
  await shot("2-running");
  await catalogShot("workspace");

  await page.locator(".seat-panel").first().click();
  await page.waitForTimeout(400);
  await shot("3-reviewer");
  await page.locator(".detail .icon-button").click(); // closing the detail

  await page.locator(".pill.phase-deliberation").waitFor({ timeout: 120_000 });
  await page.waitForTimeout(12_000);
  // The view moves to the Council tab by itself when the deliberation starts; click it for the case it did not.
  await page.getByRole("tab", { name: /Council/ }).click();
  await page.waitForTimeout(300);
  await shot("4-deliberation");
  await catalogShot("council");

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
  await catalogShot("ruling", ".action-plan");

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
