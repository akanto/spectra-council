import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { ReviewSession } from "../core/engine.ts";
import { isStanding, type Review } from "../core/model.ts";
import { MockRunner, mockProposals, mockVerification } from "../core/mock-runner.ts";
import { PROFILES } from "../core/profiles.ts";
import { newReview, reduce } from "../core/review.ts";
import { fixCheckInputSchema, proposalInputSchema, type ProfileId } from "../core/schemas.ts";
import { FakeClock, FILES } from "./support.ts";

const PROFILE_IDS: ProfileId[] = ["general", "code", "architecture", "security", "scientific"];
const seats = ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent) => ({ agent, enabled: true }));

async function complete(profile: ProfileId): Promise<Review> {
  const clock = new FakeClock();
  const base = newReview("rev", { target: "/repo", profile, depth: "standard", instructions: "", seats }, "mock", 0);
  const done = new ReviewSession(base, { runner: new MockRunner(async () => FILES, clock), clock, onChange: () => {} }).run();
  await clock.runAll();
  return done;
}

function fixed(base: Review): Review {
  let current = base;
  const ids = base.findings.filter(isStanding).map((finding) => finding.id);
  for (const findingId of ids) current = reduce(current, { type: "ruled", at: 5_000_000, findingId, decision: "accepted", note: "" });
  current = reduce(current, { type: "handoff-written", at: 5_000_001, path: "/tmp/h.md", findingIds: ids });
  current = reduce(current, { type: "fix-requested", at: 5_000_002, findingIds: ids });
  for (const findingId of ids) current = reduce(current, { type: "fix-reported", at: 5_000_003, findingId, summary: `Guarded the path in ${findingId}.`, files: ["src/engine.ts", "src/store.ts"] });
  return current;
}

const proposalJobs = (review: Review) =>
  review.reviewers.flatMap((reviewer) => {
    const findingIds = review.findings.filter((finding) => finding.reviewerId === reviewer.id && isStanding(finding)).map(({ id }) => id);
    return findingIds.length === 0 ? [] : [{ review, reviewer, profile: PROFILES[review.profile], findingIds }];
  });

describe("mockProposals", () => {
  test("are deterministic and parse with their schema", async () => {
    for (const profile of PROFILE_IDS) {
      const review = await complete(profile);
      for (const job of proposalJobs(review)) {
        const steps = mockProposals(job);
        expect(steps).toEqual(mockProposals(job));
        const proposals = steps.flatMap(({ report }) => (report.type === "fix-proposed" ? [report.proposal] : []));
        expect(proposals).toHaveLength(job.findingIds.length);
        for (const proposal of proposals) expect(proposalInputSchema.parse(proposal).steps.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("a disputed finding's proposal names a dissenter in its risks", async () => {
    let seen = 0;
    for (const profile of PROFILE_IDS) {
      const review = await complete(profile);
      for (const job of proposalJobs(review)) {
        for (const { report } of mockProposals(job)) {
          if (report.type !== "fix-proposed") continue;
          const proposal = proposalInputSchema.parse(report.proposal);
          const finding = review.findings.find((each) => each.id === proposal.findingId)!;
          if (finding.resolution?.status !== "disputed") continue;
          seen++;
          const names = finding.resolution.dissenters.map((id) => review.reviewers.find((each) => each.id === id)!.label);
          expect(names.some((name) => proposal.risks?.includes(name))).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("mockVerification", () => {
  test("is deterministic, parses, and gives a mix of verified and reopened", async () => {
    let verified = 0;
    let reopened = 0;
    for (const profile of PROFILE_IDS) {
      const review = fixed(await complete(profile));
      for (const reviewer of review.reviewers) {
        const findingIds = review.findings.filter((finding) => finding.fix && (finding.reviewerId === reviewer.id || finding.positions.some((p) => p.reviewerId === reviewer.id && p.stance === "supports"))).map(({ id }) => id);
        if (findingIds.length === 0) continue;
        const job = { review, reviewer, profile: PROFILES[profile], findingIds, pass: 1 };
        const steps = mockVerification(job);
        expect(steps).toEqual(mockVerification(job));
        const checks = steps.flatMap(({ report }) => (report.type === "fix-checked" ? [fixCheckInputSchema.parse(report.check)] : []));
        expect(checks).toHaveLength(findingIds.length);
        for (const check of checks) check.outcome === "verified" ? verified++ : reopened++;
      }
    }
    console.log(`verified ${verified}, reopened ${reopened}`);
    expect(verified).toBeGreaterThan(0);
    expect(reopened).toBeGreaterThan(0);
  });
});
