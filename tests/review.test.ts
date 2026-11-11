import { describe, expect, test } from "bun:test";
import { defaultSeats } from "../core/agents.ts";
import { isRulable, isStanding, MAX_ACTIVITY, REVIEW_FORMAT } from "../core/model.ts";
import { awaitsFixRequest, newReview, reduce, ReviewError, setupOf, upgradeReview } from "../core/review.ts";
import type { ArgumentInput, FindingInput } from "../core/schemas.ts";

/** Four seats, two taking part: the shape of a review stored before seats could be removed. */
const setup = { target: "/repo", profile: "code" as const, depth: "quick" as const, instructions: "", seats: ["mock-claude", "mock-codex", "mock-gemini", "mock-qwen"].map((agent, index) => ({ agent, enabled: index < 2 })) };
const fresh = () => newReview("rev1", setup, "mock", 0);

const finding: FindingInput = {
  title: "Off by one",
  summary: "The loop drops the last element.",
  severity: "medium",
  confidence: "high",
  category: "correctness",
  evidence: [{ path: "src/a.ts", line: 3 }],
};

describe("reduce", () => {
  test("a new review seats two agents", () => {
    const review = newReview("rev2", { ...setup, seats: defaultSeats() }, "mock", 0);
    expect(review.reviewers.map((reviewer) => [reviewer.id, reviewer.label, reviewer.enabled])).toEqual([
      ["r1", "R1 · Claude (mock)", true],
      ["r2", "R2 · Codex (mock)", true],
    ]);
  });

  test("a review with unseated seats keeps them out of the run", () => {
    const review = fresh();
    expect(review.reviewers.map((reviewer) => [reviewer.id, reviewer.label, reviewer.enabled])).toEqual([
      ["r1", "R1 · Claude (mock)", true],
      ["r2", "R2 · Codex (mock)", true],
      ["r3", "R3 · Gemini (mock)", false],
      ["r4", "R4 · Qwen (mock)", false],
    ]);
    expect(setupOf(review)).toEqual({ ...setup, deliberationRounds: 2, maxFindings: 3 });
  });

  test("configure changes the setup, and only before the start", () => {
    const seats = defaultSeats().map((seat) => ({ ...seat, enabled: true }));
    const configured = reduce(fresh(), { type: "configured", patch: { profile: "security", seats } });
    expect(configured.profile).toBe("security");
    expect(configured.reviewers.every((reviewer) => reviewer.enabled)).toBe(true);
    expect(configured.seq).toBe(1);
    const started = reduce(configured, { type: "started", at: 1 });
    expect(() => reduce(started, { type: "configured", patch: { depth: "deep" } })).toThrow(ReviewError);
  });

  test("a review with no reviewer seated can't start", () => {
    const empty = reduce(fresh(), { type: "configured", patch: { seats: defaultSeats().map((seat) => ({ ...seat, enabled: false })) } });
    expect(() => reduce(empty, { type: "started", at: 1 })).toThrow("Seat at least one reviewer");
  });

  test("findings get ids in order and the review stays in the independent review when every reviewer is done", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
    review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 12, finding });
    review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...finding, title: "Race" } });
    expect(review.findings.map((it) => [it.id, it.reviewerId, it.status])).toEqual([
      ["F1", "r2", "reported"],
      ["F2", "r1", "reported"],
    ]);
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" });
    expect(review.phase).toBe("independent-review");
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 21, outcome: "failed", problem: "crashed" });
    expect(review.phase).toBe("independent-review");
    expect(review.endedAt).toBeNull();
    expect(review.reviewers[1]).toMatchObject({ status: "failed", problem: "crashed" });
  });

  test("a stop ends the active reviewers, and later runner events change nothing", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    review = reduce(review, { type: "stopped", at: 12 });
    expect(review.phase).toBe("stopped");
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped"]);
    const late = reduce(review, { type: "activity", reviewerId: "r1", at: 13, kind: "read", text: "Reading x" });
    expect(late).toBe(review);
  });

  test("activity is capped, the count is not, and notes keep the current step", () => {
    let review = reduce(fresh(), { type: "started", at: 0 });
    review = reduce(review, { type: "reviewer-started", reviewerId: "r1", at: 0 });
    for (let i = 0; i < MAX_ACTIVITY + 10; i++) review = reduce(review, { type: "activity", reviewerId: "r1", at: i, kind: "read", text: `Reading ${i}`, path: `f${i}` });
    review = reduce(review, { type: "activity", reviewerId: "r1", at: 999, kind: "note", text: "Hmm" });
    const reviewer = review.reviewers[0]!;
    expect(reviewer.activity).toHaveLength(MAX_ACTIVITY);
    expect(reviewer.activityCount).toBe(MAX_ACTIVITY + 11);
    expect(reviewer.current).toBe(`Reading ${MAX_ACTIVITY + 9}`);
  });

  test("events for a reviewer not taking part are refused", () => {
    const review = reduce(fresh(), { type: "started", at: 0 });
    expect(() => reduce(review, { type: "reviewer-started", reviewerId: "r3", at: 1 })).toThrow("No reviewer r3");
  });
});

const argument: ArgumentInput = { findingId: "F1", stance: "challenges", confidence: "medium", text: "Not so.", evidence: [] };

/** Two reviewers seated; r2 reported F1 and r1 reported F2; both finished, so the deliberation can start. */
function reviewed() {
  let review = reduce(fresh(), { type: "started", at: 10 });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r2", at: 12, finding });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 13, finding: { ...finding, title: "Race" } });
  for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-finished", reviewerId, at: 20, outcome: "completed" });
  return review;
}

const deliberating = (rounds = 3) => reduce(reviewed(), { type: "deliberation-started", at: 30, rounds });
const inRound = (round = 1) => reduce(deliberating(), { type: "round-started", at: 31, round });
const argue = (review: ReturnType<typeof fresh>, reviewerId: string, input: Partial<ArgumentInput> = {}, at = 40) =>
  reduce(review, { type: "argued", reviewerId, at, argument: { ...argument, ...input } });

describe("deliberation", () => {
  test("it starts only from the independent review, with every reviewer done", () => {
    expect(() => reduce(fresh(), { type: "deliberation-started", at: 1, rounds: 3 })).toThrow(ReviewError);
    let busy = reduce(fresh(), { type: "started", at: 10 });
    busy = reduce(busy, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    expect(() => reduce(busy, { type: "deliberation-started", at: 12, rounds: 3 })).toThrow("still reviewing");
    expect(() => reduce(reviewed(), { type: "deliberation-started", at: 30, rounds: 0 })).toThrow(ReviewError);
    expect(() => reduce(deliberating(), { type: "deliberation-started", at: 31, rounds: 3 })).toThrow(ReviewError);
  });

  test("it seeds the reporter's support in round 0 and moves completed reviewers to deliberating", () => {
    const review = deliberating();
    expect(review.phase).toBe("deliberation");
    expect([review.round, review.rounds]).toEqual([0, 3]);
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["deliberating", "deliberating"]);
    expect(review.findings[0]!.positions).toEqual([{ reviewerId: "r2", stance: "supports", confidence: "high", round: 0, at: 30 }]);
    expect(review.findings[1]!.positions).toMatchObject([{ reviewerId: "r1", stance: "supports", round: 0 }]);
  });

  test("a failed reviewer stays failed and doesn't take part", () => {
    let review = reduce(fresh(), { type: "started", at: 10 });
    for (const reviewerId of ["r1", "r2"]) review = reduce(review, { type: "reviewer-started", reviewerId, at: 11 });
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 20, outcome: "completed" });
    review = reduce(review, { type: "reviewer-finished", reviewerId: "r2", at: 20, outcome: "failed", problem: "crashed" });
    review = reduce(review, { type: "deliberation-started", at: 30, rounds: 2 });
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["deliberating", "failed"]);
    review = reduce(review, { type: "round-started", at: 31, round: 1 });
    expect(review.reviewers[1]!.status).toBe("failed");
    expect(argue(review, "r2")).toBe(review);
  });

  test("rounds come in order and within the count", () => {
    const review = deliberating(2);
    expect(() => reduce(review, { type: "round-started", at: 31, round: 2 })).toThrow("can't follow");
    expect(() => reduce(fresh(), { type: "round-started", at: 31, round: 1 })).toThrow(ReviewError);
    let next = reduce(review, { type: "round-started", at: 31, round: 1 });
    expect(next.round).toBe(1);
    next = reduce(next, { type: "round-started", at: 32, round: 2 });
    expect(next.round).toBe(2);
    expect(() => reduce(next, { type: "round-started", at: 33, round: 3 })).toThrow(ReviewError);
    expect(() => reduce(next, { type: "round-started", at: 33, round: 2 })).toThrow(ReviewError);
  });

  test("arguments get ids A1.. and carry the round, and need a round under way", () => {
    expect(() => argue(deliberating(), "r1")).toThrow("deliberation round");
    const done = reviewed(); // its reviewers are finished, so a stray argument is ignored like any late runner event
    expect(argue(done, "r1")).toBe(done);
    let review = argue(inRound(), "r1", {}, 40);
    review = argue(review, "r2", { findingId: "F2", stance: "supports", replyTo: "A1" }, 41);
    expect(review.arguments.map((it) => [it.id, it.reviewerId, it.findingId, it.round, it.at])).toEqual([
      ["A1", "r1", "F1", 1, 40],
      ["A2", "r2", "F2", 1, 41],
    ]);
    expect(review.arguments[1]!.replyTo).toBe("A1");
    expect(review.arguments[0]).not.toHaveProperty("replyTo");
    expect(review.reviewers[0]!.activity.at(-1)).toMatchObject({ kind: "argument" });
  });

  test("unknown findings and replies are refused", () => {
    expect(() => argue(inRound(), "r1", { findingId: "F9" })).toThrow("no finding F9");
    expect(() => argue(inRound(), "r1", { replyTo: "A7" })).toThrow("no argument A7");
  });

  test("a reviewer who isn't in the deliberation can't argue", () => {
    expect(() => argue(inRound(), "r3")).toThrow("No reviewer r3");
    const review = reduce(inRound(), { type: "reviewer-finished", reviewerId: "r1", at: 35, outcome: "failed" });
    expect(review.reviewers[0]!.status).toBe("failed");
    expect(argue(review, "r1")).toBe(review);
  });

  test("the latest stance of a reviewer on a finding replaces its old one", () => {
    let review = argue(inRound(), "r1", { stance: "challenges" }, 40);
    review = argue(review, "r2", { stance: "supports" }, 41);
    review = argue(review, "r1", { stance: "uncertain", confidence: "low" }, 42);
    const positions = review.findings[0]!.positions;
    expect(positions).toHaveLength(2);
    expect(positions.find((it) => it.reviewerId === "r1")).toMatchObject({ stance: "uncertain", confidence: "low", round: 1, at: 42 });
    expect(positions.find((it) => it.reviewerId === "r2")).toMatchObject({ stance: "supports", round: 1 });
    expect(review.arguments).toHaveLength(3);
  });

  test("a finding is resolved only in the synthesis", () => {
    const resolve = { type: "finding-resolved" as const, at: 50, findingId: "F1", status: "disputed" as const, rationale: "1 of 2 back it.", dissenters: ["r1"] };
    expect(() => reduce(inRound(), resolve)).toThrow(ReviewError);
    let review = reduce(inRound(), { type: "synthesis-started", at: 49 });
    expect(review.phase).toBe("synthesis");
    expect(() => reduce(review, { ...resolve, findingId: "F9" })).toThrow("no finding F9");
    expect(() => reduce(fresh(), { type: "synthesis-started", at: 1 })).toThrow(ReviewError);
    review = reduce(review, resolve);
    expect(review.findings[0]).toMatchObject({ status: "disputed", resolution: { status: "disputed", rationale: "1 of 2 back it.", dissenters: ["r1"], at: 50 } });
    expect(review.findings[1]!.status).toBe("reported");
  });

  test("concluding sets the verdict, completes the review and its deliberating reviewers", () => {
    let review = reduce(inRound(), { type: "synthesis-started", at: 49 });
    review = reduce(review, { type: "concluded", at: 60, summary: "All good." });
    expect(review).toMatchObject({ phase: "complete", endedAt: 60, verdict: { summary: "All good.", at: 60 } });
    expect(review.reviewers.slice(0, 2).map((reviewer) => [reviewer.status, reviewer.endedAt])).toEqual([["completed", 60], ["completed", 60]]);
  });

  test("a review with nothing to deliberate concludes straight from the independent review", () => {
    const review = reduce(reviewed(), { type: "concluded", at: 25, summary: "Done." });
    expect(review.phase).toBe("complete");
    expect(review.verdict?.summary).toBe("Done.");
  });

  test("it can't conclude before setup, while reviewers review, or twice", () => {
    expect(() => reduce(fresh(), { type: "concluded", at: 1, summary: "x" })).toThrow(ReviewError);
    let busy = reduce(fresh(), { type: "started", at: 10 });
    busy = reduce(busy, { type: "reviewer-started", reviewerId: "r1", at: 11 });
    expect(() => reduce(busy, { type: "concluded", at: 12, summary: "x" })).toThrow("still reviewing");
    const done = reduce(reviewed(), { type: "concluded", at: 25, summary: "x" });
    expect(() => reduce(done, { type: "concluded", at: 26, summary: "y" })).toThrow(ReviewError);
  });

  test("a stop during the deliberation stops the deliberating reviewers, and later events change nothing", () => {
    const review = reduce(inRound(), { type: "stopped", at: 45 });
    expect(review.phase).toBe("stopped");
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["stopped", "stopped"]);
    expect(argue(review, "r1")).toBe(review);
    expect(reduce(review, { type: "reviewer-finished", reviewerId: "r1", at: 46, outcome: "completed" })).toBe(review);
    expect(reduce(review, { type: "stopped", at: 47 })).toBe(review);
  });

  test("seq goes up by one per event that changes the review", () => {
    const base = inRound();
    expect(argue(base, "r1").seq).toBe(base.seq + 1);
    expect(reduce(base, { type: "synthesis-started", at: 1 }).seq).toBe(base.seq + 1);
    const stopped = reduce(base, { type: "stopped", at: 1 });
    expect(reduce(stopped, { type: "stopped", at: 2 }).seq).toBe(stopped.seq);
  });
});

const proposal = { findingId: "F1", summary: "Fix the loop.", steps: ["Change <= to <"], files: ["src/a.ts"], verification: "Add a test." };
const check = (findingId: string, outcome: "verified" | "reopened") => ({ findingId, outcome, text: "Looked.", evidence: [] });

/** In the synthesis with F1 agreed and F2 withdrawn. */
function settling() {
  let review = reduce(inRound(), { type: "synthesis-started", at: 49 });
  review = reduce(review, { type: "finding-resolved", at: 50, findingId: "F1", status: "agreed", rationale: "All back it.", dissenters: [] });
  review = reduce(review, { type: "finding-resolved", at: 51, findingId: "F2", status: "withdrawn", rationale: "Conceded.", dissenters: [] });
  return review;
}

const concluded = () => reduce(settling(), { type: "concluded", at: 60, summary: "Done." });
const rule = (review: ReturnType<typeof fresh>, findingId: string, decision: "accepted" | "dismissed" | "deferred" | null, at = 61) =>
  reduce(review, { type: "ruled", at, findingId, decision, note: "ok" });
const accepted = () => rule(concluded(), "F1", "accepted");
const handedOffReview = () => {
  const review = reduce(accepted(), { type: "handoff-written", at: 62, path: "/repo/h.md", findingIds: ["F1"] });
  return reduce(review, { type: "fix-requested", at: 63, findingIds: ["F1"] });
};
const fixedReview = () => reduce(handedOffReview(), { type: "fix-reported", at: 64, findingId: "F1", summary: "Changed it", files: ["src/a.ts"] });
const verifying = () => reduce(fixedReview(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r1", "r2"] });

describe("fix proposals", () => {
  test("a reviewer proposes a fix for a standing finding in the synthesis", () => {
    const review = reduce(settling(), { type: "fix-proposed", reviewerId: "r2", at: 52, proposal });
    expect(review.findings[0]!.proposal).toEqual({ drafterId: "r2", summary: "Fix the loop.", steps: ["Change <= to <"], files: ["src/a.ts"], verification: "Add a test.", at: 52 });
    expect(review.reviewers[1]!.activity.at(-1)).toMatchObject({ kind: "proposal", path: "src/a.ts" });
    expect(review.reviewers[1]!.current).not.toContain("Proposed");
  });

  test("it is refused outside the synthesis, for an unresolved or withdrawn finding, or an unknown one", () => {
    expect(() => reduce(inRound(), { type: "fix-proposed", reviewerId: "r2", at: 52, proposal })).toThrow("synthesis");
    const early = reduce(inRound(), { type: "synthesis-started", at: 49 });
    expect(() => reduce(early, { type: "fix-proposed", reviewerId: "r2", at: 52, proposal })).toThrow("doesn't stand");
    expect(() => reduce(settling(), { type: "fix-proposed", reviewerId: "r1", at: 52, proposal: { ...proposal, findingId: "F2" } })).toThrow("doesn't stand");
    expect(() => reduce(settling(), { type: "fix-proposed", reviewerId: "r2", at: 52, proposal: { ...proposal, findingId: "F9" } })).toThrow("no finding F9");
  });
});

describe("rulings", () => {
  test("the user rules once the verdict is in, and null clears it", () => {
    expect(() => rule(settling(), "F1", "accepted")).toThrow("verdict");
    let review = rule(concluded(), "F1", "accepted", 61);
    expect(review.findings[0]!.ruling).toEqual({ decision: "accepted", note: "ok", at: 61 });
    review = rule(review, "F1", "dismissed", 62);
    expect(review.findings[0]!.ruling?.decision).toBe("dismissed");
    review = rule(review, "F1", null);
    expect(review.findings[0]!.ruling).toBeNull();
    expect(() => rule(concluded(), "F9", "accepted")).toThrow("no finding F9");
  });

  test("a stopped review can't be ruled on", () => {
    const stopped = reduce(inRound(), { type: "stopped", at: 45 });
    expect(() => rule(stopped, "F1", "accepted")).toThrow(ReviewError);
  });

  test("a handed-off finding not fixed yet can be taken out of the fixes, or keep its acceptance with a new note", () => {
    const dismissed = rule(handedOffReview(), "F1", "dismissed");
    expect(dismissed.findings[0]!.ruling?.decision).toBe("dismissed");
    expect(dismissed.findings[0]!.fix).toBeNull();
    expect(rule(handedOffReview(), "F1", null).findings[0]!.fix).toBeNull();
    const kept = rule(handedOffReview(), "F1", "accepted");
    expect(kept.findings[0]!.fix?.state).toBe("handed-off");
    // another finding is still open to rulings
    expect(rule(handedOffReview(), "F2", "deferred").findings[1]!.ruling?.decision).toBe("deferred");
  });

  test("a fixed finding's ruling can't change", () => {
    const fixed = reduce(handedOffReview(), { type: "fix-reported", at: 70, findingId: "F1", summary: "Done.", files: [] });
    expect(() => rule(fixed, "F1", "dismissed")).toThrow("is fixed already");
  });
});

describe("hand-off", () => {
  const write = (review: ReturnType<typeof fresh>, findingIds: string[]) => reduce(review, { type: "handoff-written", at: 62, path: "/repo/h.md", findingIds });

  test("it records the path and the accepted findings", () => {
    expect(write(accepted(), ["F1"]).handoff).toEqual({ path: "/repo/h.md", findingIds: ["F1"], at: 62 });
  });

  test("it needs at least one finding, all accepted, and a verdict", () => {
    expect(() => write(accepted(), [])).toThrow("at least one");
    expect(() => write(rule(concluded(), "F1", "deferred"), ["F1"])).toThrow("F1 isn't accepted");
    expect(() => write(accepted(), ["F1", "F2"])).toThrow("F2 isn't accepted");
    expect(() => write(accepted(), ["F9"])).toThrow("no finding F9");
    expect(() => write(settling(), ["F1"])).toThrow("verdict");
  });

  test("a later hand-off replaces the earlier", () => {
    const first = write(accepted(), ["F1"]);
    const both = write(rule(first, "F2", "accepted", 63), ["F1", "F2"]);
    expect(both.handoff!.findingIds).toEqual(["F1", "F2"]);
  });
});

describe("fixes", () => {
  const request = (review: ReturnType<typeof fresh>, findingIds: string[]) => reduce(review, { type: "fix-requested", at: 63, findingIds });
  const handed = () => reduce(accepted(), { type: "handoff-written", at: 62, path: "/repo/h.md", findingIds: ["F1"] });

  test("a request needs the hand-off and only its findings", () => {
    expect(() => request(accepted(), ["F1"])).toThrow("Write the hand-off");
    expect(() => request(handed(), ["F2"])).toThrow("F2 isn't in the hand-off");
    expect(() => request(settling(), ["F1"])).toThrow(ReviewError);
  });

  test("a request hands the findings off", () => {
    expect(request(handed(), ["F1"]).findings[0]!.fix).toEqual({ state: "handed-off", handedOffAt: 63, fixer: null, problem: null, summary: null, files: [], fixedAt: null, checks: [] });
    expect(request(handed(), ["F1"]).findings[1]!.fix).toBeNull();
  });

  test("a request with a profile marks the fixer, and a repeated one leaves work waiting for or with its fixer alone", () => {
    const first = reduce(handed(), { type: "fix-requested", at: 63, findingIds: ["F1"], profile: "codex" });
    expect(first.findings[0]!.fix).toMatchObject({ state: "handed-off", handedOffAt: 63, fixer: { profile: "codex", conversationId: null }, problem: null });
    // Waiting for its conversation: neither this conversation's agent nor another profile takes it over.
    expect(reduce(first, { type: "fix-requested", at: 70, findingIds: ["F1"] }).findings[0]!.fix).toEqual(first.findings[0]!.fix);
    expect(reduce(first, { type: "fix-requested", at: 70, findingIds: ["F1"], profile: "gemini" }).findings[0]!.fix).toEqual(first.findings[0]!.fix);
    // Being fixed: its conversation keeps it.
    const delegated = reduce(first, { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" });
    expect(reduce(delegated, { type: "fix-requested", at: 71, findingIds: ["F1"], profile: "codex" }).findings[0]!.fix).toEqual(delegated.findings[0]!.fix);
    expect(reduce(delegated, { type: "fix-requested", at: 71, findingIds: ["F1"] }).findings[0]!.fix).toEqual(delegated.findings[0]!.fix);
    // With this conversation's agent: it keeps it too.
    const chair = handedOffReview();
    expect(reduce(chair, { type: "fix-requested", at: 70, findingIds: ["F1"], profile: "codex" }).findings[0]!.fix).toEqual(chair.findings[0]!.fix);
  });

  /** F1 and F2 accepted and in the hand-off. */
  const handedBoth = () => reduce(rule(accepted(), "F2", "accepted", 62), { type: "handoff-written", at: 62, path: "/repo/h.md", findingIds: ["F1", "F2"] });

  test("accepting another finding while one is being fixed hands off only the new one", () => {
    let review = reduce(handed(), { type: "fix-requested", at: 63, findingIds: ["F1"], profile: "codex" });
    review = reduce(review, { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" });
    review = rule(review, "F2", "accepted", 65);
    review = reduce(review, { type: "handoff-written", at: 66, path: "/repo/h.md", findingIds: ["F1", "F2"] });
    review = reduce(review, { type: "fix-requested", at: 67, findingIds: ["F1", "F2"], profile: "codex" });
    expect(review.findings[0]!.fix).toMatchObject({ state: "handed-off", handedOffAt: 63, fixer: { profile: "codex", conversationId: "c9" } });
    expect(review.findings[1]!.fix).toMatchObject({ state: "handed-off", handedOffAt: 67, fixer: { profile: "codex", conversationId: null } });
    // A delegation can't take F1 from its conversation; F2 goes to a conversation of its own.
    expect(() => reduce(review, { type: "fix-delegated", at: 68, findingIds: ["F1", "F2"], profile: "codex", conversationId: "c10" })).toThrow("F1 is with codex's conversation c9 already");
    review = reduce(review, { type: "fix-delegated", at: 68, findingIds: ["F2"], profile: "codex", conversationId: "c10" });
    expect(review.findings.map((finding) => finding.fix!.fixer!.conversationId)).toEqual(["c9", "c10"]);
  });

  test("a request after a failed fix hands only the failed findings to a new owner", () => {
    let review = reduce(handedBoth(), { type: "fix-requested", at: 63, findingIds: ["F1", "F2"], profile: "codex" });
    review = reduce(review, { type: "fix-delegated", at: 64, findingIds: ["F1", "F2"], profile: "codex", conversationId: "c9" });
    review = reduce(review, { type: "fix-failed", at: 65, findingIds: ["F1"], reason: "codex: no" });
    const again = reduce(review, { type: "fix-requested", at: 70, findingIds: ["F1", "F2"], profile: "gemini" });
    expect(again.findings[0]!.fix).toMatchObject({ state: "handed-off", handedOffAt: 70, fixer: { profile: "gemini", conversationId: null }, problem: null });
    expect(again.findings[1]!.fix).toEqual(review.findings[1]!.fix);
  });

  test("which findings a request hands off: new, reopened and failed ones, not ones waiting for or with a fixer, nor fixed ones", () => {
    expect(awaitsFixRequest(accepted().findings[0]!)).toBe(true);
    expect(awaitsFixRequest(handedOffReview().findings[0]!)).toBe(false);
    expect(awaitsFixRequest(reduce(handedOffReview(), { type: "fix-failed", at: 64, findingIds: ["F1"], reason: "no" }).findings[0]!)).toBe(true);
    expect(awaitsFixRequest(fixedReview().findings[0]!)).toBe(false);
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "reopened") });
    review = reduce(review, { type: "verification-ended", at: 72 });
    expect(awaitsFixRequest(review.findings[0]!)).toBe(true);
    // A reopened finding waits for a new request, not for a delegation.
    expect(() => reduce(review, { type: "fix-delegated", at: 73, findingIds: ["F1"], profile: "codex", conversationId: "c9" })).toThrow("isn't waiting for a fix");
  });

  test("a request leaves fixed and verified findings untouched, even with a profile", () => {
    const fixed = fixedReview();
    expect(reduce(fixed, { type: "fix-requested", at: 80, findingIds: ["F1"], profile: "codex" }).findings[0]!.fix).toEqual(fixed.findings[0]!.fix);
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") });
    review = reduce(review, { type: "verification-ended", at: 72 });
    expect(review.findings[0]!.fix!.state).toBe("verified");
    expect(reduce(review, { type: "fix-requested", at: 80, findingIds: ["F1"], profile: "codex" }).findings[0]!.fix).toEqual(review.findings[0]!.fix);
  });

  test("a request clears the problem of a failed fix", () => {
    const failed = reduce(handedOffReview(), { type: "fix-failed", at: 64, findingIds: ["F1"], reason: "no" });
    expect(failed.findings[0]!.fix!.problem).toBe("no");
    expect(reduce(failed, { type: "fix-requested", at: 65, findingIds: ["F1"] }).findings[0]!.fix!.problem).toBeNull();
  });

  test("delegating records the conversation on findings handed to that profile", () => {
    const asked = reduce(handed(), { type: "fix-requested", at: 63, findingIds: ["F1"], profile: "codex" });
    const delegated = reduce(asked, { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" });
    expect(delegated.findings[0]!.fix).toMatchObject({ state: "handed-off", fixer: { profile: "codex", conversationId: "c9" } });
  });

  test("delegating is refused for a finding that doesn't wait, or was handed to another profile or none", () => {
    const asked = reduce(handed(), { type: "fix-requested", at: 63, findingIds: ["F1"], profile: "codex" });
    expect(() => reduce(asked, { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "gemini", conversationId: "c9" })).toThrow("handed to codex, not gemini");
    expect(() => reduce(handedOffReview(), { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" })).toThrow("this conversation's agent");
    expect(() => reduce(accepted(), { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" })).toThrow("isn't waiting for a fix");
    expect(() => reduce(fixedReview(), { type: "fix-delegated", at: 64, findingIds: ["F1"], profile: "codex", conversationId: "c9" })).toThrow("isn't waiting for a fix");
    expect(() => reduce(asked, { type: "fix-delegated", at: 64, findingIds: ["F9"], profile: "codex", conversationId: "c9" })).toThrow("no finding F9");
  });

  test("a failed fix sets the problem on waiting findings only", () => {
    const failed = reduce(handedOffReview(), { type: "fix-failed", at: 64, findingIds: ["F1", "F2"], reason: "It crashed." });
    expect(failed.findings[0]!.fix).toMatchObject({ state: "handed-off", problem: "It crashed." });
    expect(failed.findings[1]!.fix).toBeNull();
    const fixed = fixedReview();
    expect(reduce(fixed, { type: "fix-failed", at: 65, findingIds: ["F1"], reason: "x" }).findings[0]!.fix).toEqual(fixed.findings[0]!.fix);
    expect(() => reduce(handedOffReview(), { type: "fix-failed", at: 64, findingIds: ["F9"], reason: "x" })).toThrow("no finding F9");
  });

  test("a reported fix clears the problem", () => {
    const failed = reduce(handedOffReview(), { type: "fix-failed", at: 64, findingIds: ["F1"], reason: "no" });
    const fixed = reduce(failed, { type: "fix-reported", at: 65, findingId: "F1", summary: "Now", files: [] });
    expect(fixed.findings[0]!.fix).toMatchObject({ state: "fixed", problem: null });
  });

  test("a request keeps fixed findings as they are", () => {
    const fixed = fixedReview();
    const again = request(fixed, ["F1"]);
    expect(again.findings[0]!.fix).toEqual(fixed.findings[0]!.fix);
    expect(again.findings[0]!.fix!.state).toBe("fixed");
  });

  test("a request hands a reopened finding off again and keeps its history", () => {
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "reopened") });
    review = reduce(review, { type: "verification-ended", at: 72 });
    expect(review.findings[0]!.fix!.state).toBe("reopened");
    const again = reduce(review, { type: "fix-requested", at: 80, findingIds: ["F1"] });
    expect(again.findings[0]!.fix).toMatchObject({ state: "handed-off", handedOffAt: 80, summary: "Changed it", files: ["src/a.ts"], fixedAt: 64 });
    expect(again.findings[0]!.fix!.checks).toHaveLength(1);
  });

  test("a fix is reported on a handed-off finding in the complete phase", () => {
    expect(fixedReview().findings[0]!.fix).toMatchObject({ state: "fixed", summary: "Changed it", files: ["src/a.ts"], fixedAt: 64 });
    expect(() => reduce(accepted(), { type: "fix-reported", at: 64, findingId: "F1", summary: "s", files: [] })).toThrow("wasn't handed off");
    expect(() => reduce(handedOffReview(), { type: "fix-reported", at: 64, findingId: "F9", summary: "s", files: [] })).toThrow("no finding F9");
    expect(() => reduce(settling(), { type: "fix-reported", at: 64, findingId: "F1", summary: "s", files: [] })).toThrow(ReviewError);
    expect(() => reduce(verifying(), { type: "fix-reported", at: 64, findingId: "F1", summary: "s", files: [] })).toThrow("being re-checked");
  });

  test("a fix can be reported again until it is verified, then not", () => {
    const again = reduce(fixedReview(), { type: "fix-reported", at: 65, findingId: "F1", summary: "Better", files: [] });
    expect(again.findings[0]!.fix).toMatchObject({ summary: "Better", files: [], fixedAt: 65 });
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") });
    review = reduce(review, { type: "verification-ended", at: 72 });
    expect(() => reduce(review, { type: "fix-reported", at: 73, findingId: "F1", summary: "s", files: [] })).toThrow("verified already");
  });
});

describe("verification", () => {
  test("it starts only from a complete review with fixed findings, and puts the checkers in verifying", () => {
    expect(() => reduce(handedOffReview(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r1"] })).toThrow("no fix to re-check");
    expect(() => reduce(fixedReview(), { type: "verification-started", at: 70, findingIds: [], reviewerIds: ["r1"] })).toThrow("No fixed finding");
    expect(() => reduce(settling(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r1"] })).toThrow(ReviewError);
    const review = reduce(fixedReview(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r2"] });
    expect(review).toMatchObject({ phase: "verification", verifications: 1 });
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["completed", "verifying"]);
    expect(() => reduce(review, { type: "verification-started", at: 71, findingIds: ["F1"], reviewerIds: ["r2"] })).toThrow(ReviewError);
  });

  test("a failed or unseated reviewer is not put into verifying", () => {
    const review = reduce(fixedReview(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r3", "r1"] });
    expect(review.reviewers.map((reviewer) => reviewer.status)).toEqual(["verifying", "completed", "idle", "idle"]);
  });

  test("checks are recorded for fixed findings by verifying reviewers, one per reviewer per pass", () => {
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "reopened") });
    review = reduce(review, { type: "fix-checked", reviewerId: "r1", at: 72, check: check("F1", "verified") });
    review = reduce(review, { type: "fix-checked", reviewerId: "r2", at: 73, check: check("F1", "verified") });
    expect(review.findings[0]!.fix!.checks.map((it) => [it.reviewerId, it.outcome, it.pass, it.at])).toEqual([
      ["r1", "verified", 1, 72],
      ["r2", "verified", 1, 73],
    ]);
    expect(review.reviewers[0]!.activity.at(-1)).toMatchObject({ kind: "check" });
  });

  test("a check is refused outside a verification, for a finding that is not fixed, or an unknown one", () => {
    // outside a verification no reviewer is verifying, so a stray check is ignored like any late runner event
    const idle = fixedReview();
    expect(reduce(idle, { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") })).toBe(idle);
    expect(() => reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F2", "verified") })).toThrow("no fix to re-check");
    expect(() => reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F9", "verified") })).toThrow("no finding F9");
  });

  test("a check from a reviewer not verifying changes nothing", () => {
    const review = reduce(fixedReview(), { type: "verification-started", at: 70, findingIds: ["F1"], reviewerIds: ["r2"] });
    expect(reduce(review, { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") })).toBe(review);
  });

  test("ending verifies the findings when no check reopened them, and frees the reviewers", () => {
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") });
    review = reduce(review, { type: "fix-checked", reviewerId: "r2", at: 72, check: check("F1", "verified") });
    review = reduce({ ...review, agentHeardAt: 5 }, { type: "verification-ended", at: 73 });
    expect(review.phase).toBe("complete");
    expect(review.findings[0]!.fix!.state).toBe("verified");
    expect(review.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["completed", "completed"]);
    expect(review.agentHeardAt).toBeNull();
  });

  test("any reopening check reopens the finding", () => {
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") });
    review = reduce(review, { type: "fix-checked", reviewerId: "r2", at: 72, check: check("F1", "reopened") });
    expect(reduce(review, { type: "verification-ended", at: 73 }).findings[0]!.fix!.state).toBe("reopened");
  });

  test("a finding with no check stays fixed, and only this pass's checks count", () => {
    expect(reduce(verifying(), { type: "verification-ended", at: 73 }).findings[0]!.fix!.state).toBe("fixed");
    // pass 1 reopened; a new fix is reported; in pass 2 nobody checks: stays fixed rather than reopened again
    let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "reopened") });
    review = reduce(review, { type: "verification-ended", at: 73 });
    review = reduce(review, { type: "fix-requested", at: 74, findingIds: ["F1"] });
    review = reduce(review, { type: "fix-reported", at: 75, findingId: "F1", summary: "again", files: [] });
    review = reduce(review, { type: "verification-started", at: 76, findingIds: ["F1"], reviewerIds: ["r1"] });
    expect(review.verifications).toBe(2);
    expect(reduce(review, { type: "verification-ended", at: 77 }).findings[0]!.fix!.state).toBe("fixed");
  });

  test("it can't end when none runs", () => {
    expect(() => reduce(fixedReview(), { type: "verification-ended", at: 1 })).toThrow("No verification");
  });

  test("a stop or interruption goes back to complete without settling", () => {
    for (const type of ["stopped", "interrupted"] as const) {
      let review = reduce(verifying(), { type: "fix-checked", reviewerId: "r1", at: 71, check: check("F1", "verified") });
      review = { ...review, agentHeardAt: 5 };
      const ended = reduce(review, { type, at: 80 });
      expect(ended.phase).toBe("complete");
      expect(ended.findings[0]!.fix!.state).toBe("fixed");
      expect(ended.reviewers.slice(0, 2).map((reviewer) => reviewer.status)).toEqual(["completed", "completed"]);
      expect(ended.agentHeardAt).toBe(5);
      expect(ended.endedAt).toBe(60);
    }
  });

  test("agent-unheard hands a heard review back to the ended note", () => {
    const heard = reduce(concluded(), { type: "agent-heard", at: 81 });
    expect(heard.agentHeardAt).toBe(81);
    expect(reduce(heard, { type: "agent-unheard" }).agentHeardAt).toBeNull();
  });
});

describe("upgradeReview", () => {
  test("a format-2 review gets empty proposals, rulings, fixes, hand-off and verifications", () => {
    const { handoff: _h, verifications: _v, ...rest } = concluded();
    const old = {
      ...rest,
      format: 2,
      findings: concluded().findings.map(({ proposal: _p, ruling: _r, fix: _f, ...finding }) => finding),
    } as unknown as ReturnType<typeof fresh>;
    const upgraded = upgradeReview(old);
    expect(upgraded.format).toBe(REVIEW_FORMAT);
    expect(upgraded.handoff).toBeNull();
    expect(upgraded.verifications).toBe(0);
    expect(upgraded.verdict).toEqual(old.verdict);
    expect(upgraded.findings.map((it) => [it.status, it.proposal, it.ruling, it.fix])).toEqual([["agreed", null, null, null], ["withdrawn", null, null, null]]);
    expect(upgraded.findings[0]!.resolution).toEqual(old.findings[0]!.resolution);
  });

  test("a format-3 review gets no fixer and no problem on its fixes", () => {
    const current = fixedReview();
    const old = {
      ...current,
      format: 3,
      findings: current.findings.map((it) => (it.fix ? { ...it, fix: (({ fixer: _f, problem: _p, ...rest }) => rest)(it.fix) } : it)),
    } as unknown as ReturnType<typeof fresh>;
    const upgraded = upgradeReview(old);
    expect(upgraded.format).toBe(REVIEW_FORMAT);
    expect(upgraded.findings[0]!.fix).toEqual({ ...current.findings[0]!.fix!, fixer: null, problem: null });
    expect(upgraded.findings[1]!.fix).toBeNull();
  });

  test("the review format is 8", () => {
    expect(REVIEW_FORMAT).toBe(8);
  });

  test("a current review is returned as it is", () => {
    const review = concluded();
    expect(upgradeReview(review)).toBe(review);
  });
});


test("reported findings gain individual rulings only after a review without deliberation", () => {
  let review = reduce(fresh(), { type: "started", at: 1 });
  review = reduce(review, { type: "finding-reported", reviewerId: "r1", at: 2, finding });
  const report = review.findings[0]!;
  for (const phase of ["setup", "independent-review", "stopped", "interrupted", "deliberation", "synthesis"] as const) {
    expect(isRulable({ ...review, phase }, report)).toBe(false);
  }
  for (const phase of ["complete", "verification"] as const) expect(isRulable({ ...review, phase }, report)).toBe(true);
  expect(isRulable({ ...review, phase: "complete", rounds: 2 }, report)).toBe(false);
  expect(isStanding(report)).toBe(false);
});
