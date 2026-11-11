/**
 * The built view (dist/view.js) in a real browser, around the real host: setup renders, a review on mock seats runs to
 * its verdict, the Council and Findings tabs open, and nothing throws. Twice: in Chrome as a plain page, and in WebKit
 * (the engine of Mirador's app) framed as Mirador frames plugin items, where every error the frame reports fails the run.
 * Chrome and WebKit come from the machine (playwright-core downloads none: `bunx playwright-core install webkit`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type FrameLocator, type Page } from "playwright-core";
import { UNNAMED_PROFILE } from "../core/agents.ts";
import { newReview, reduce, setupOf } from "../core/review.ts";
import type { Review } from "../core/model.ts";
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

/** Completed reports with original evidence, including repeated reports merged from the second reviewer. */
function fixture(target: string, mode: "single" | "failed" | "council" = "council"): Review {
  const agents = mode === "single" ? ["mock-claude"] : ["mock-claude", "mock-codex"];
  let review = newReview("regression", { target, profile: "code", depth: "quick", instructions: "", seats: agents.map((agent) => ({ agent, enabled: true })) }, "mock", 0);
  review = reduce(review, { type: "started", at: 1 });
  for (const reviewer of review.reviewers) review = reduce(review, { type: "reviewer-started", reviewerId: reviewer.id, at: 2 });
  for (let i = 0; i < (mode === "council" ? 5 : 3); i++) {
    review = reduce(review, { type: "finding-reported", reviewerId: i >= 3 ? "r2" : "r1", at: 3 + i, finding: {
      title: `Report ${i + 1}`, summary: "The original report summary", category: "correctness", severity: i === 1 ? "low" : "high", confidence: "high",
      evidence: [{ path: "src/source.ts", line: 3, endLine: 5, quote: "original evidence quote", note: "original evidence note" }], recommendation: "Use the recommended fix.",
    } });
  }
  for (const reviewer of review.reviewers) review = reduce(review, { type: "reviewer-finished", reviewerId: reviewer.id, at: 10, outcome: mode === "failed" && reviewer.id === "r2" ? "failed" : "completed", problem: "Reviewer failed to respond" });
  if (mode === "council") {
    review = reduce(review, { type: "findings-merged", at: 11, into: "F1", merged: ["F4", "F5"] });
    review = reduce(review, { type: "deliberation-started", at: 12, rounds: 1 });
    review = reduce(review, { type: "synthesis-started", at: 13 });
    for (const finding of review.findings) {
      review = reduce(review, { type: "finding-resolved", at: 14, findingId: finding.id, status: "agreed", rationale: "Both back it", dissenters: [] });
      review = reduce(review, { type: "fix-proposed", at: 15, reviewerId: "r1", proposal: { findingId: finding.id, summary: "Proposed repair", steps: ["Repair it"], files: ["src/source.ts"], verification: "Run tests" } });
    }
  }
  return reduce(review, { type: "concluded", at: 20, summary: "Review complete" });
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

  const freshPage = async () => {
    // WebKit reports aborted long polls as access-control errors during navigation. Detach only for teardown;
    // keep all errors collected while the app was running, and monitor the new page from its creation.
    page.removeAllListeners("pageerror");
    page.removeAllListeners("console");
    await page.close();
    page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => (message.type() === "error" || message.text().startsWith("FRAME ERROR: ")) && errors.push(message.text()));
    await page.goto(harness.url);
    root = setup.mirador ? page.frameLocator("iframe") : page;
  };
  const load = async (review: Review) => {
    harness.setReview(review);
    await freshPage();
    await root.getByRole("tab", { name: "Workspace" }).waitFor();
  };
  const findings = async () => { await root.getByRole("tab", { name: /Findings/ }).click(); };
  const openFirst = async () => { await root.locator("#finding-F1 .finding-row").click(); };

  for (const mode of ["single", "failed"] as const) test(`${mode}: reported findings can be ruled on and sent for fixes`, async () => {
    await load(fixture(harness.target, mode));
    expect(await root.getByRole("tab", { name: "Council" }).count()).toBe(0);
    await root.getByRole("button", { name: "Open Findings to rule and fix →" }).click();
    await root.getByText("These reports have not been corroborated", { exact: false }).waitFor();
    expect(await root.getByRole("button", { name: /Accept all/ }).count()).toBe(0);
    await openFirst();
    const card = root.locator("#finding-F1");
    for (const label of ["Dismiss", "Later", "Accept"]) {
      await card.getByRole("button", { name: label, exact: true }).click();
      await card.locator(`button[aria-pressed="true"]`).waitFor();
      expect(await card.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed")).toBe("true");
    }
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    await card.getByRole("heading", { name: "Rule on this finding" }).waitFor();
    expect(harness.review().findings[0]!.ruling).toBeNull();
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    await root.getByRole("button", { name: "Write hand-off", exact: true }).click();
    await root.getByRole("button", { name: /Ask agent to fix/ }).click();
    await card.getByText("Waiting for the agent to report the fix.").waitFor();
    expect(harness.review().handoff!.findingIds).toEqual(["F1"]);
    expect(harness.review().findings[0]!.status).toBe("reported");
    expect(harness.review().findings[0]!.resolution).toBeNull();
    let review = reduce(harness.review(), { type: "fix-reported", at: 30, findingId: "F1", summary: "Repaired", files: ["src/source.ts"] });
    review = reduce(review, { type: "verification-started", at: 31, findingIds: ["F1"], reviewerIds: ["r1"] });
    harness.setReview(review);
    await root.locator(".pill.phase-verification").waitFor();
    expect(await root.getByRole("region", { name: "Action plan" }).isVisible()).toBe(true);
    expect(await card.locator(".fix-status").isVisible()).toBe(true);
  }, 30_000);

  test("active, stopped and empty reports do not offer individual rulings", async () => {
    for (const phase of ["independent-review", "stopped"] as const) {
      await load({ ...fixture(harness.target, "single"), phase });
      await findings();
      await openFirst();
      expect(await root.getByRole("group", { name: "Your ruling" }).count()).toBe(0);
      expect(await root.getByRole("region", { name: "Action plan" }).count()).toBe(0);
    }
    await load({ ...fixture(harness.target, "single"), findings: [] });
    await findings();
    await root.getByText("No findings were reported.").waitFor();
    expect(await root.getByRole("region", { name: "Action plan" }).count()).toBe(0);
  });

  test("Council has original evidence and tab switches preserve the selected finding", async () => {
    await load(fixture(harness.target));
    await root.getByRole("tab", { name: "Council" }).click();
    await root.locator(".council-item").filter({ hasText: "F3" }).click();
    const detail = root.locator(".council-detail");
    expect(await detail.getByText("correctness", { exact: true }).isVisible()).toBe(true);
    expect(await detail.getByText("original evidence quote", { exact: true }).isVisible()).toBe(true);
    expect(await detail.getByText("original evidence note", { exact: false }).isVisible()).toBe(true);
    expect(await detail.getByText("Use the recommended fix.", { exact: true }).isVisible()).toBe(true);
    expect(await detail.getByRole("button", { name: "src/source.ts:3-5", exact: true }).isVisible()).toBe(true);
    await shot("6-original-evidence");
    await findings();
    await root.locator("#finding-F3.open").waitFor();
    await root.locator("#finding-F2 .finding-row").click();
    await root.getByRole("tab", { name: "Council" }).click();
    expect(await root.locator(".council-detail .finding-id").textContent()).toBe("F2");
  });

  test("merged reporters have canonical counts and ruling works within combined filters", async () => {
    await load(fixture(harness.target));
    expect(await root.getByRole("button", { name: /R2 · Codex \(mock\),.*1 finding/ }).count()).toBe(1);
    await findings();
    const reporters = root.getByRole("group", { name: "Reviewer", exact: true });
    await reporters.getByRole("button", { name: "R2 · Codex (mock) 1", exact: true }).click();
    expect(await root.locator(".finding-card").count()).toBe(1);
    await root.getByRole("group", { name: "Severity", exact: true }).getByRole("button", { name: "high 2", exact: true }).click();
    await root.getByRole("group", { name: "Status", exact: true }).getByRole("button", { name: "Agreed 3", exact: true }).click();
    await openFirst();
    await root.locator("#finding-F1").getByRole("button", { name: "Accept", exact: true }).click();
    await root.getByRole("group", { name: "Ruling", exact: true }).getByRole("button", { name: "Accepted 1", exact: true }).click();
    expect(await root.locator(".finding-card").count()).toBe(1);
    expect(await root.getByRole("button", { name: /Next to rule/ }).count()).toBe(0);
    expect(await root.locator("#finding-F1 .proposal").isVisible()).toBe(true);
    await reporters.getByRole("button", { name: "R1 · Claude (mock) 3", exact: true }).click();
    expect(await root.locator(".finding-card").count()).toBe(1);
  });

  test("next ruling stays within the active filters", async () => {
    await load(fixture(harness.target));
    await findings();
    await root.getByRole("group", { name: "Severity", exact: true }).getByRole("button", { name: "high 2", exact: true }).click();
    await openFirst();
    await root.locator("#finding-F1").getByRole("button", { name: "Accept", exact: true }).click();
    await root.getByRole("button", { name: "Next to rule: F3 →", exact: true }).click();
    await root.locator("#finding-F3.open").waitFor();
    expect(await root.locator("#finding-F2").count()).toBe(0);
  });

  test("evidence and proposal links resolve file and folder targets and show missing-target errors", async () => {
    const file = join(harness.target, "report with spaces.md");
    await writeFile(file, "report");
    for (const target of [file, harness.target + "/"]) {
      const review = fixture(target);
      review.findings[0]!.evidence[0]!.path = "report with spaces.md";
      review.findings[0]!.proposal!.files = ["report with spaces.md"];
      await load(review);
      await findings();
      await openFirst();
      await root.locator("#finding-F1 .evidence button").click();
      await root.locator("#finding-F1 .proposal-files button").click();
      await page.waitForFunction(() => (window as any).__openedPaths.length === 2);
      expect(await page.evaluate(() => (window as any).__openedPaths)).toEqual([file, file]);
    }
    await load(fixture(join(harness.target, "missing")));
    await findings();
    await openFirst();
    await root.locator("#finding-F1 .evidence button").click();
    await root.getByRole("alert").filter({ hasText: "unavailable" }).waitFor();
    expect(await page.evaluate(() => (window as any).__openedPaths)).toEqual([]);
  });

  test("switching a profile seat to Other profile blocks Start until the new name is typed", async () => {
    const review = newReview("other-profile", { target: harness.target, profile: "code", depth: "quick", instructions: "", seats: [{ agent: "profile:alpha", enabled: true }] }, "mirador", 0);
    harness.setReview(review);
    await freshPage();
    const start = root.getByRole("button", { name: "Start review", exact: true });
    expect(await start.isEnabled()).toBe(true);
    await root.getByRole("combobox", { name: "Agent for reviewer 1" }).selectOption({ label: "Other profile…" });
    const name = root.getByRole("textbox", { name: "Mirador profile for reviewer 1" });
    expect(await name.inputValue()).toBe("");
    expect(await name.evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
    await root.getByText("Name the profile for reviewer 1").waitFor();
    expect(await start.isDisabled()).toBe(true);
    // The old profile is gone from the review itself, so nothing can start it.
    const seatAgent = () => setupOf(harness.review()).seats[0]?.agent;
    expect(seatAgent()).toBe(UNNAMED_PROFILE);
    // Typing, without leaving the field, seats the new name once the typing pauses.
    await name.pressSequentially("beta");
    await start.waitFor({ state: "visible" });
    for (let i = 0; i < 50 && !(await start.isEnabled()); i++) await page.waitForTimeout(50);
    expect(await start.isEnabled()).toBe(true);
    expect(seatAgent()).toBe("profile:beta");
    expect(await name.inputValue()).toBe("beta");
    // Seating the name mid-typing keeps the field and its focus: more keys after the pause still land.
    await page.keyboard.type("-two");
    for (let i = 0; i < 50 && seatAgent() !== "profile:beta-two"; i++) await page.waitForTimeout(50);
    expect(await name.inputValue()).toBe("beta-two");
    expect(seatAgent()).toBe("profile:beta-two");
    // Clearing the field and leaving it never brings the old profile back.
    await name.fill("");
    await name.blur();
    expect(seatAgent()).not.toBe("profile:alpha");
  });

  test("Setup acknowledges a prompted start and offers an explicit retry", async () => {
    const review = newReview("prompted", { target: harness.target, profile: "code", depth: "quick", instructions: "", seats: [{ agent: "profile:alpha", enabled: true }] }, "mirador", 0);
    harness.setReview(review);
    harness.restartHost();
    await freshPage();
    const count = harness.prompts.length;
    const start = root.getByRole("button", { name: "Start review", exact: true });
    await start.click();
    await root.getByRole("status").filter({ hasText: "Asked the agent to start the review" }).waitFor();
    expect(await start.isDisabled()).toBe(true);
    expect(harness.prompts.length).toBe(count + 1);
    await root.getByRole("button", { name: "Retry start", exact: true }).click();
    expect(await start.isEnabled()).toBe(true);
  });

  test("a review opened in place of an unstarted one shows its own setup, not the old one's half-made choices", async () => {
    const setupOn = (id: string, agent: string) => newReview(id, { target: harness.target, profile: "code", depth: "quick", instructions: "", seats: [{ agent, enabled: true }] }, "mirador", 0);
    harness.setReview(setupOn("unstarted", "profile:alpha"));
    await freshPage();
    await root.getByRole("combobox", { name: "Agent for reviewer 1" }).selectOption({ label: "Other profile…" });
    const name = root.getByRole("textbox", { name: "Mirador profile for reviewer 1" });
    await name.waitFor();
    harness.setReview(setupOn("in-its-place", "profile:beta"));
    await name.waitFor({ state: "detached" });
    expect(await root.getByRole("combobox", { name: "Agent for reviewer 1" }).inputValue()).toBe("profile:beta");
  });

  test("instructions typed just before a review is replaced stay with the review they were typed in", async () => {
    const setupOn = (id: string) => newReview(id, { target: harness.target, profile: "code", depth: "quick", instructions: "", seats: [{ agent: "mock-claude", enabled: true }] }, "mock", 0);
    const typed = "Mind the cache.";
    harness.setReview(setupOn("typed-on"));
    await freshPage();
    const instructions = root.getByRole("textbox", { name: /Instructions/ });
    await instructions.fill("");
    await instructions.type(typed);
    for (let i = 0; i < 50 && harness.review().instructions !== typed; i++) await page.waitForTimeout(50);
    expect(harness.review().instructions).toBe(typed);
    // Typed on again, and the agent opens another review before the pause that commits what was typed: the words stay
    // with the review they were typed in, and the user hears no error about them.
    await instructions.type(" and the queue");
    harness.setReview(setupOn("in-its-place"));
    await page.waitForTimeout(900);
    expect([harness.review().id, harness.review().instructions]).toEqual(["in-its-place", ""]);
    expect(await root.getByRole("alert").count()).toBe(0);
  });

  test("reviewer detail opens at its header and follows live activity beyond the retained limit", async () => {
    const review = fixture(harness.target, "failed");
    for (const reviewer of review.reviewers) {
      reviewer.activity = Array.from({ length: 150 }, (_, seq) => ({ seq, at: seq, kind: "note" as const, text: `Activity ${seq}` }));
      reviewer.activityCount = 150;
    }
    await load(review);
    for (const name of ["R1 · Claude (mock)", "R2 · Codex (mock)"]) {
      await root.getByRole("button", { name: new RegExp(`${name.replace(/[()]/g, "\\$&")},.*open activity`) }).click();
      expect(await root.locator(".detail").evaluate((node) => node.scrollTop)).toBe(0);
      expect(await root.locator(".detail h2").textContent()).toBe(name);
    }
    expect(await root.locator(".detail .problem").textContent()).toBe("Reviewer failed to respond");
    await page.setViewportSize({ width: 600, height: 900 });
    await root.locator(".detail").getByRole("button", { name: "Close", exact: true }).click();
    await root.getByRole("button", { name: /R2 · Codex \(mock\),.*open activity/ }).click();
    const heading = await root.locator(".detail h2").boundingBox();
    // Scrolled to the panel's top edge, give or take sub-pixel rounding.
    expect(heading!.y).toBeGreaterThan(-1);
    expect(heading!.y).toBeLessThan(900);
    await page.setViewportSize({ width: 960, height: 900 });
    await root.getByRole("button", { name: /R1 · Claude \(mock\),.*open activity/ }).click();
    const active = structuredClone(review);
    active.phase = "independent-review";
    active.reviewers[0]!.status = "reviewing";
    harness.setReview(active);
    await root.locator(".seat-panel.is-reviewing").waitFor();
    harness.setReview(reduce(active, { type: "activity", reviewerId: "r1", at: 151, kind: "note", text: "Latest live event" }));
    await root.locator(".detail").getByText("Latest live event", { exact: true }).waitFor();
    // Wait for the post-render scrolling effect, including browsers with asynchronous scrolling.
    await root.locator(".detail").evaluate(async (node) => { for (let i = 0; i < 30 && node.scrollTop === 0; i++) await new Promise(requestAnimationFrame); });
    expect(await root.locator(".detail").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(harness.review().reviewers[0]!.activity).toHaveLength(150);
    expect(harness.review().reviewers[0]!.activityCount).toBe(151);
  });

  test("nothing threw", () => {
    expect(errors).toEqual([]);
  });
});
