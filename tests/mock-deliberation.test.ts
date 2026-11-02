import { describe, expect, test } from "bun:test";
import { ReviewSession } from "../core/engine.ts";
import type { Review } from "../core/model.ts";
import { MockRunner, mockDeliberation } from "../core/mock-runner.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview } from "../core/review.ts";
import { argumentInputSchema, type ProfileId } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const AGENTS = ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"];

const start = (profile: ProfileId) =>
  newReview("rev", { target: "/repo", profile, depth: "standard", instructions: "", seats: AGENTS.map((agent) => ({ agent, enabled: true })) }, "mock", 0);

/** Plays a whole review, handing every deliberation job to `inspect` first. */
async function play(profile: ProfileId, inspect: (steps: ReturnType<typeof mockDeliberation>, review: Review) => void = () => {}): Promise<Review> {
  const clock = new FakeClock();
  const mock = new MockRunner(async () => FILES, clock);
  const runner = {
    run: mock.run.bind(mock),
    async deliberate(job: Parameters<typeof mock.deliberate>[0], report: Parameters<typeof mock.deliberate>[1], signal: AbortSignal) {
      inspect(mockDeliberation(job), job.review);
      await mock.deliberate(job, report, signal);
    },
  };
  const done = new ReviewSession(start(profile), { runner, clock, onChange: () => {} }).run();
  await clock.runAll();
  return done;
}

describe("mockDeliberation", () => {
  test("is the same for the same job", async () => {
    const final = await play("architecture");
    const job = { review: { ...final, round: 1 }, reviewer: final.reviewers[0]!, profile: PROFILES.architecture, round: 1, rounds: 3 };
    expect(mockDeliberation(job)).toEqual(mockDeliberation(job));
  });

  test("every argued report parses and refers to existing findings and arguments", async () => {
    let seen = 0;
    await play("code", (steps, review) => {
      for (const { report } of steps) {
        if (report.type !== "argued") continue;
        const argument = argumentInputSchema.parse(report.argument);
        seen++;
        expect(review.findings.some((finding) => finding.id === argument.findingId)).toBe(true);
        if (argument.replyTo !== undefined) expect(review.arguments.some((each) => each.id === argument.replyTo)).toBe(true);
        if (argument.stance === "challenges" && argument.replyTo === undefined) expect(argument.evidence.length).toBeGreaterThan(0);
      }
    });
    expect(seen).toBeGreaterThan(10);
  });

  test("a reviewer with nothing to answer says so", async () => {
    const final = await play("code");
    const settled = { ...final, round: 3, arguments: [], findings: final.findings.map((finding) => ({ ...finding, positions: finding.positions.map((p) => ({ ...p, stance: "supports" as const })) })) };
    const steps = mockDeliberation({ review: settled, reviewer: settled.reviewers[0]!, profile: PROFILES.code, round: 3, rounds: 3 });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.report).toMatchObject({ type: "activity", text: "Nothing new to answer in round 3" });
  });
});

describe("a full mock deliberation", () => {
  for (const profile of ["architecture", "code"] as const) {
    test(`${profile}: leaves agreed, confirmed, disputed and withdrawn findings`, async () => {
      const final = await play(profile);
      const statuses = new Set(final.findings.map((finding) => finding.status));
      for (const status of ["agreed", "confirmed", "disputed", "withdrawn"] as const) expect(statuses.has(status)).toBe(true);
      expect(final.phase).toBe("complete");
    });
  }

  test("the same run twice gives the same arguments", async () => {
    const strip = (review: Review) => review.arguments.map(({ at, ...rest }) => rest);
    expect(strip(await play("security"))).toEqual(strip(await play("security")));
  });
});
