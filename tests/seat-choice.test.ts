import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { AgentRunner } from "../core/agent-runner.ts";
import { promptTitle } from "../core/agent-turns.ts";
import { choiceOf, expectedModel, offered, sameChoice, type ProfileInfo } from "../core/agents.ts";
import type { AgentReply, Conversations } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce, setupOf } from "../core/review.ts";
import { createCouncilHost } from "../hosts/mirador/host.ts";
import { noRecords } from "../hosts/mirador/records.ts";
import { FakeCanvas, FakeClock, FILES } from "./support.ts";

const seatsOf = (...seats: { agent: string; enabled?: boolean; model?: string; effort?: string }[]) => seats.map((seat) => ({ enabled: true, ...seat }));
const reviewOf = (...seats: Parameters<typeof seatsOf>) => newReview("rev", { target: "/work/repo", profile: "code", depth: "standard", instructions: "", seats: seatsOf(...seats) }, "mirador", 0);

describe("choiceOf, sameChoice", () => {
  test("a profile seat's model and effort, trimmed", () => {
    expect(choiceOf({ agent: "profile:Home", model: " opus ", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(choiceOf({ agent: "profile:Home", effort: "low" })).toEqual({ effort: "low" });
  });
  test("none when neither is set (or blank), and none for a mock", () => {
    expect(choiceOf({ agent: "profile:Home" })).toBeUndefined();
    expect(choiceOf({ agent: "profile:Home", model: "  ", effort: "" })).toBeUndefined();
    expect(choiceOf({ agent: "mock-claude", model: "opus", effort: "high" })).toBeUndefined();
  });
  test("sameChoice treats absent as the profile's own", () => {
    expect(sameChoice(undefined, undefined)).toBe(true);
    expect(sameChoice(undefined, {})).toBe(true);
    expect(sameChoice({ model: "opus" }, { model: "opus" })).toBe(true);
    expect(sameChoice({ model: "opus" }, undefined)).toBe(false);
    expect(sameChoice({ model: "opus", effort: "high" }, { model: "opus", effort: "low" })).toBe(false);
  });
});

describe("expectedModel", () => {
  const profile: ProfileInfo = {
    name: "Home",
    harness: "claude",
    model: { name: "Sonnet 5.5", effort: "low" },
    models: [{ value: "opus", name: "Opus 5.5" }],
    efforts: [{ value: "high", name: "High" }],
  };
  test("without a choice, the profile's own", () => expect(expectedModel(profile, undefined)).toEqual({ name: "Sonnet 5.5", effort: "low" }));
  test("a chosen model is named by value or by name, case-insensitively", () => {
    // Another model than the profile's latest: its effort is unknown until it runs.
    expect(expectedModel(profile, { model: "OPUS" })).toEqual({ name: "Opus 5.5", effort: null });
    expect(expectedModel(profile, { model: "Sonnet 5.5" })).toEqual({ name: "Sonnet 5.5", effort: "low" });
    expect(expectedModel(profile, { model: "opus 5.5" })?.name).toBe("Opus 5.5");
  });
  test("an unknown model or effort is used raw, as given", () => {
    expect(expectedModel(profile, { model: "mystery", effort: "Max" })).toEqual({ name: "mystery", effort: "Max" });
  });
  test("a chosen effort is named through the profile's efforts", () => expect(expectedModel(profile, { effort: "HIGH" })).toEqual({ name: "Sonnet 5.5", effort: "High" }));
  test("offered finds a choice by exact value first, then by value or name in any case", () => {
    const list = [
      { value: "high", name: "High" },
      { value: "High", name: "Odd" },
    ];
    expect(offered(list, "High")?.name).toBe("Odd");
    expect(offered(list, "HIGH")?.value).toBe("high");
    expect(offered([{ value: "opus", name: "Opus 5.5" }], "opus 5.5")?.value).toBe("opus");
    expect(offered(list, "max")).toBeUndefined();
    expect(offered(undefined, "max")).toBeUndefined();
  });
  test("null when nothing is known", () => {
    expect(expectedModel(undefined, undefined)).toBeNull();
    expect(expectedModel({ name: "Fresh", harness: "claude", model: null }, undefined)).toBeNull();
    expect(expectedModel({ name: "Fresh", harness: "claude", model: null }, { model: "opus" })).toEqual({ name: "opus", effort: null });
  });
});

describe("a seat's choice in the review", () => {
  test("newReview and configured carry it into reviewers and setupOf", () => {
    const review = reduce(reviewOf({ agent: "profile:Home" }), {
      type: "configured",
      patch: { seats: seatsOf({ agent: "profile:Home", model: "opus", effort: "high" }, { agent: "profile:Pi" }) },
    });
    expect(review.reviewers[0]!.choice).toEqual({ model: "opus", effort: "high" });
    expect(review.reviewers[1]!.choice).toBeUndefined();
    expect(setupOf(review).seats).toEqual([
      { agent: "profile:Home", enabled: true, model: "opus", effort: "high" },
      { agent: "profile:Pi", enabled: true },
    ]);
  });
  test("a mock seat with a model gets no choice", () => {
    const review = reviewOf({ agent: "mock-claude", model: "opus" });
    expect(review.reviewers[0]!.choice).toBeUndefined();
    expect(setupOf(review).seats).toEqual([{ agent: "mock-claude", enabled: true }]);
  });
  test("the seen model is kept while agent and choice stay, reset when the choice changes", () => {
    const seat = { agent: "profile:Home", model: "opus" };
    let review = reduce(reviewOf(seat), { type: "model-seen", reviewerId: "r1", model: { name: "Opus 5.5", effort: "high" } });
    expect(review.reviewers[0]!.model).not.toBeNull();
    review = reduce(review, { type: "configured", patch: { seats: seatsOf(seat) } });
    expect(review.reviewers[0]!.model).toEqual({ name: "Opus 5.5", effort: "high" });
    review = reduce(review, { type: "configured", patch: { seats: seatsOf({ ...seat, effort: "low" }) } });
    expect(review.reviewers[0]!.model).toBeNull();
  });
});

describe("AgentRunner and the seat's choice", () => {
  const asks = async (seat: Parameters<typeof seatsOf>[0], replies: (string | null)[]) => {
    const requests: Parameters<Conversations["ask"]>[0][] = [];
    const conversations: Conversations = {
      async ask(request) {
        requests.push(request);
        const text = replies[requests.length - 1] ?? null;
        return { conversationId: `c${requests.length}`, profile: request.profile, ended: "finished", text } as AgentReply;
      },
    };
    const review = reviewOf(seat);
    await new AgentRunner(conversations, new FakeClock()).run({ review, reviewer: review.reviewers[0]!, profile: PROFILES.code }, () => {}, new AbortController().signal);
    return requests;
  };
  const valid = "```json\n" + JSON.stringify({ findings: [] }) + "\n```";

  test("passes model and effort to the ask", async () => {
    const [request] = await asks({ agent: "profile:Home", model: "opus", effort: "high" }, [valid]);
    expect(request).toMatchObject({ profile: "Home", model: "opus", effort: "high" });
  });
  test("passes none for a seat without a choice", async () => {
    const [request] = await asks({ agent: "profile:Home" }, [valid]);
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("effort");
  });
  test("the JSON repair ask keeps the choice", async () => {
    const requests = await asks({ agent: "profile:Home", model: "opus" }, ["no json here", valid]);
    expect(requests).toHaveLength(2);
    expect(requests.map((each) => each.model)).toEqual(["opus", "opus"]);
  });
});

describe("promptTitle", () => {
  test("the first line, trimmed", () => {
    expect(promptTitle("  Spectra Council rev1 · review  \nBody\nmore")).toBe("Spectra Council rev1 · review");
    expect(promptTitle("single")).toBe("single");
    expect(promptTitle("")).toBe("");
  });
});

describe("the Mirador host and seat choices", () => {
  const target = tmpdir();

  function setup() {
    const clock = new FakeClock();
    const host = createCouncilHost({ clock, listFiles: async () => FILES, newId: () => "rev1", throttleMs: 0, writeFile: async () => {} });
    const canvas = new FakeCanvas<Review>();
    return { clock, host, canvas, context: canvas.context() };
  }
  const startedBy = async (agents: unknown[]) => {
    const { clock, host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await clock.settle();
    return { canvas, started: canvas.started };
  };

  test("council_open accepts an object seat and seats it with its choice", async () => {
    const { host, canvas, context } = setup();
    const answer = await host.tools.council_open!.run({ target, agents: [{ agent: "profile:Home", model: "opus", effort: "high" }, "profile:Pi", "mock-gemini"] }, context);
    const review = canvas.items[0]!.data;
    expect(review.reviewers.map((each) => each.choice)).toEqual([{ model: "opus", effort: "high" }, undefined, undefined]);
    expect(review.reviewers.map((each) => each.agent)).toEqual(["profile:Home", "profile:Pi", "mock-gemini"]);
    expect(String(answer)).toContain("opus, high effort");
  });
  test("plain strings are still accepted", async () => {
    const { host, canvas, context } = setup();
    await host.tools.council_open!.run({ target, agents: ["profile:Home"] }, context);
    expect(canvas.items[0]!.data.reviewers[0]!.choice).toBeUndefined();
  });
  test("an agent turn starts titled by the prompt's first line, on the seat's model and effort", async () => {
    const { started } = await startedBy([{ agent: "profile:Home", model: "opus", effort: "high" }]);
    expect(started.length).toBeGreaterThan(0);
    const first = started[0]!;
    expect(first.title).toBe(first.prompt.split("\n")[0]!.trim());
    expect(first.title).toContain("Spectra Council");
    expect(first).toMatchObject({ profile: "Home", model: "opus", effort: "high" });
  });
  test("a choice goes to Mirador as the value the profile's agent offers", async () => {
    const records = {
      ...noRecords,
      profiles: () => [{ name: "Home", harness: "claude", model: null, models: [{ value: "opus", name: "Opus 5.5" }], efforts: [{ value: "high", name: "high" }] }],
    };
    const clock = new FakeClock();
    const host = createCouncilHost({ clock, records, listFiles: async () => FILES, newId: () => "rev1", throttleMs: 0, writeFile: async () => {} });
    const canvas = new FakeCanvas<Review>();
    const context = canvas.context();
    await host.tools.council_open!.run({ target, agents: [{ agent: "profile:home", model: "Opus 5.5", effort: "High" }] }, context);
    await host.action!(canvas.items[0]!, { kind: "start" }, context);
    await clock.settle();
    expect(canvas.started[0]).toMatchObject({ model: "opus", effort: "high" });
  });
  test("a seat without a choice has no model or effort keys at all", async () => {
    const { started } = await startedBy(["profile:Home"]);
    expect(started.length).toBeGreaterThan(0);
    expect(started[0]).toHaveProperty("title");
    expect(started[0]).not.toHaveProperty("model");
    expect(started[0]).not.toHaveProperty("effort");
  });
});
