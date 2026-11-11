/**
 * The review's process as the user lives it, step by step, and where it is: what the view's process strip draws.
 * Pure: derived from the review alone, so the strip never stores anything of its own.
 *
 * Six steps, not the engine's phases: synthesis and fix proposals take moments, so they fold into the verdict, and the
 * rulings, fixes and re-checks after it (all in phase "complete" or "verification") get steps of their own.
 */
import { isRulable, seatedReviewers, type Finding, type ResumablePhase, type Review } from "./model.ts";

export type FlowStepId = "setup" | "review" | "deliberate" | "verdict" | "rule" | "recheck";

/**
 * - done: reached and finished.
 * - current: where the review is now; at most one step at a time.
 * - ahead: not reached yet.
 * - skipped: this review doesn't go through it (one reviewer: no deliberation; nothing fixed: no re-check).
 * - stopped / interrupted: the step the user's stop or a restart cut short; the steps after it stay ahead.
 */
export type FlowState = "done" | "current" | "ahead" | "skipped" | "stopped" | "interrupted";

export interface FlowStep {
  id: FlowStepId;
  /** The step's name: "Setup", "Review", "Deliberate", "Verdict", "Rule & fix", "Re-check". */
  title: string;
  state: FlowState;
  /** A few words under the name: live progress on the current step, what it does or did on the others. */
  detail: string;
  /** A sentence on what happens in the step, for its tooltip. */
  explain: string;
}

export interface Flow {
  /** Always the six steps, in order. */
  steps: FlowStep[];
  /** Every step done or skipped: nothing is left to do for this review. */
  settled: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const EXPLAIN: Record<FlowStepId, string> = {
  setup: "Choose the profile, the reviewers and the depth, then start the review.",
  review: "Each reviewer examines the target on its own and reports findings with evidence; duplicates are merged.",
  deliberate: "In rounds, every reviewer backs, challenges or questions each finding, with evidence; reporters answer the challenges.",
  verdict: "Each finding is settled as agreed, confirmed, disputed or withdrawn, and its reporter drafts a fix for the ones that stand.",
  rule: "You accept, dismiss or defer each finding; accepted ones are fixed by the agent or a fixer profile, or filed as issues.",
  recheck: "The reviewers who backed a fixed finding check the fix: verified, or reopened for another go.",
};

const TITLES: Record<FlowStepId, string> = {
  setup: "Setup",
  review: "Review",
  deliberate: "Deliberate",
  verdict: "Verdict",
  rule: "Rule & fix",
  recheck: "Re-check",
};

const ORDER: FlowStepId[] = ["setup", "review", "deliberate", "verdict", "rule", "recheck"];

const STEP_OF_PHASE: Record<ResumablePhase, FlowStepId> = {
  "independent-review": "review",
  deliberation: "deliberate",
  synthesis: "verdict",
};

/** Fixed or verified: the fix work on it is done until a re-check says otherwise. */
const fixDone = (finding: Finding) => finding.fix?.state === "fixed" || finding.fix?.state === "verified";
/** An accepted finding with nothing left to do before the re-check: fixed, or filed as an issue. */
const acceptedHandled = (finding: Finding) => fixDone(finding) || (finding.ticket?.id != null && finding.fix === null);

/** Why the deliberation is skipped, or null when it happens (or still may). */
function deliberationSkipped(review: Review): string | null {
  // Rounds ran: a reviewer removed since doesn't undo them.
  if (review.rounds > 0) return null;
  const seated = seatedReviewers(review).length;
  if (seated < 2) return "skipped: 1 reviewer";
  // Past the independent review with no rounds: the engine concluded without a council.
  const past = review.phase === "complete" || review.phase === "verification";
  if (past && review.rounds === 0) {
    if (review.findings.every((finding) => finding.late === true)) return "skipped: no findings";
    return "skipped: 1 finished";
  }
  return null;
}

/** The step a stopped or interrupted review was cut in. A stop recorded before `stoppedPhase` was kept is guessed. */
function cutStep(review: Review): FlowStepId {
  const phase = review.phase === "interrupted" ? review.interruptedPhase : review.stoppedPhase;
  if (phase) return STEP_OF_PHASE[phase];
  return review.rounds > 0 ? "deliberate" : "review";
}

export function flowOf(review: Review): Flow {
  const seated = seatedReviewers(review);
  const rulable = review.findings.filter((finding) => isRulable(review, finding));
  const ruled = rulable.filter((finding) => finding.ruling !== null);
  const accepted = rulable.filter((finding) => finding.ruling?.decision === "accepted");
  const fixes = review.findings.filter((finding) => finding.fix !== null);
  const fixed = fixes.filter(fixDone);
  const verified = fixes.filter((finding) => finding.fix?.state === "verified");
  const reopened = fixes.filter((finding) => finding.fix?.state === "reopened");
  const toCheck = fixes.filter((finding) => finding.fix?.state === "fixed");
  // In a re-check, the fixes put to this pass (a fix reported during it waits for the next).
  const checking = fixes.filter((finding) => finding.fix?.state === "fixed" && finding.fix.recheckedIn === review.verifications);
  const skippedDeliberation = deliberationSkipped(review);

  const ahead: Record<FlowStepId, string> = {
    setup: "pick reviewers",
    review: `≤${review.maxFindings} findings each`,
    deliberate: skippedDeliberation ?? plural(review.deliberationRounds, "round"),
    verdict: "settle findings",
    rule: "accept · fix",
    recheck: "check fixes",
  };
  const state = new Map<FlowStepId, FlowState>();
  const detail = new Map<FlowStepId, string>();
  const set = (id: FlowStepId, to: FlowState, words?: string) => {
    state.set(id, to);
    if (words !== undefined) detail.set(id, words);
  };

  const reviewDone = `${plural(review.findings.length, "finding")}`;
  const deliberateDone = skippedDeliberation ?? plural(review.rounds, "round");

  switch (review.phase) {
    case "setup":
      set("setup", "current", plural(seated.length, "reviewer"));
      break;
    case "independent-review": {
      set("setup", "done");
      const finished = seated.filter((reviewer) => reviewer.status === "completed" || reviewer.status === "failed").length;
      set("review", "current", `${finished} of ${seated.length} done`);
      break;
    }
    case "deliberation":
      set("setup", "done");
      set("review", "done", reviewDone);
      set("deliberate", "current", review.round === 0 ? "grouping" : `round ${review.round} of ${review.rounds}`);
      break;
    case "synthesis":
      set("setup", "done");
      set("review", "done", reviewDone);
      set("deliberate", skippedDeliberation ? "skipped" : "done", deliberateDone);
      set("verdict", "current", "settling");
      break;
    case "stopped":
    case "interrupted": {
      const cut = cutStep(review);
      const cutAt = ORDER.indexOf(cut);
      for (const id of ORDER.slice(0, cutAt)) set(id, "done");
      if (cutAt > ORDER.indexOf("review")) set("review", "done", reviewDone);
      if (cutAt > ORDER.indexOf("deliberate")) set("deliberate", skippedDeliberation ? "skipped" : "done", deliberateDone);
      const how = review.phase === "stopped" ? "stopped" : "interrupted";
      const where = cut === "deliberate" && review.round > 0 ? ` · round ${review.round}` : "";
      set(cut, review.phase, `${how}${where}`);
      break;
    }
    case "complete":
    case "verification": {
      set("setup", "done");
      set("review", "done", reviewDone);
      set("deliberate", skippedDeliberation ? "skipped" : "done", deliberateDone);
      set("verdict", "done", rulable.length === 0 ? "nothing stands" : `${rulable.length} to rule`);

      const ruleOpen = ruled.length < rulable.length || accepted.some((finding) => !acceptedHandled(finding));
      const ruleWords =
        rulable.length === 0
          ? "nothing to rule"
          : ruleOpen
            ? `${ruled.length}/${rulable.length} ruled${fixed.length > 0 ? ` · ${fixed.length} fixed` : ""}`
            : `${accepted.length} accepted · ${fixed.length} fixed`;
      const passes = review.verifications > 0 ? (reopened.length > 0 ? `${reopened.length} reopened` : plural(review.verifications, "pass")) : null;

      if (review.phase === "verification") {
        // One step at a time: the re-check is where the review is; the rulings wait for it.
        set("rule", "done", ruleWords);
        set("recheck", "current", `checking ${checking.length}`);
      } else if (ruleOpen) {
        set("rule", "current", ruleWords);
        if (passes) detail.set("recheck", passes);
      } else {
        set("rule", "done", ruleWords);
        if (toCheck.length > 0) set("recheck", "current", `${toCheck.length} to check`);
        else if (fixes.length === 0) set("recheck", "skipped", "nothing fixed");
        else if (verified.length === fixes.length) set("recheck", "done", `${verified.length} verified`);
        // A fix still being made (on a ticketed finding, say): nothing to check yet.
        else detail.set("recheck", passes ?? `${verified.length} of ${fixes.length} verified`);
      }
      break;
    }
  }

  // Not reached yet: ahead, unless this review won't go through it.
  for (const id of ORDER) if (!state.has(id)) state.set(id, id === "deliberate" && skippedDeliberation ? "skipped" : "ahead");

  const steps = ORDER.map((id): FlowStep => ({
    id,
    title: TITLES[id],
    state: state.get(id)!,
    detail: detail.get(id) ?? (id === "setup" && state.get(id) === "done" ? plural(seated.length, "reviewer") : ahead[id]),
    explain: EXPLAIN[id],
  }));
  return { steps, settled: steps.every((step) => step.state === "done" || step.state === "skipped") };
}
