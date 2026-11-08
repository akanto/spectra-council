/**
 * The video's reviewers: a ReviewerRunner that plays script.ts for the seat a reviewer sits in (its Mirador profile's
 * name), on the clock, as a real reviewer's reports would come in. Findings are told apart by their titles, so the
 * arguments, fixes and checks land on whatever ids the review gave them. `SPEED` above 1 plays it faster.
 */
import type { Clock, DeliberationJob, ProposalJob, Report, ReviewerJob, ReviewerRunner, VerificationJob } from "../../core/engine.ts";
import type { Review } from "../../core/model.ts";
import { CHECKS, GROUPS, PROPOSALS, REVIEWS, ROUNDS, SEATS, TITLES, type Key, type Seat } from "./script.ts";

/** The rounds a little slower than the script's times, so the thread unfolds on camera. */
const ROUND_PACE = 1.5;

const seatOf = (agent: string): Seat | undefined => SEATS.find(({ name }) => `profile:${name}` === agent)?.name;

/** The key of a finding id, by its title or the title of a report merged into it. */
function keyOf(review: Review, id: string): Key | undefined {
  const finding = review.findings.find((each) => each.id === id) ?? review.findings.find((each) => each.alsoReported.some((report) => report.findingId === id));
  return finding ? TITLES[finding.title] : undefined;
}

/** The id a key goes by now, in the review. */
function idOf(review: Review, key: Key): string | undefined {
  return review.findings.find((finding) => TITLES[finding.title] === key)?.id;
}

const fill = (review: Review, text: string) => text.replace(/\{(\w+)\}/g, (all, key: string) => idOf(review, key as Key) ?? all);

export class ScriptedRunner implements ReviewerRunner {
  constructor(
    private readonly clock: Clock,
    private readonly speed = 1,
  ) {}

  /** Whether this runner plays a seat. */
  static plays(agent: string) {
    return seatOf(agent) !== undefined;
  }

  private wait(ms: number, signal: AbortSignal) {
    return this.clock.sleep(Math.round(ms / this.speed), signal);
  }

  async run(job: ReviewerJob, report: (report: Report) => void, signal: AbortSignal) {
    const seat = seatOf(job.reviewer.agent)!;
    const model = SEATS.find(({ name }) => name === seat)!.model;
    report({ type: "model-seen", model });
    for (const step of REVIEWS[seat]) {
      await this.wait(step.ms, signal);
      if (step.kind === "finding") report({ type: "finding-reported", finding: step.finding });
      else report({ type: "activity", kind: step.kind, text: step.text, ...(step.path ? { path: step.path } : {}) });
    }
  }

  async group(job: ReviewerJob, report: (report: Report) => void, signal: AbortSignal) {
    report({ type: "activity", kind: "status", text: "Comparing the findings for duplicates" });
    for (const { key, reason } of GROUPS) {
      await this.wait(1500, signal);
      const ids = job.review.findings.filter((finding) => TITLES[finding.title] === key).map(({ id }) => id);
      if (ids.length > 1) report({ type: "duplicates-grouped", group: { findingIds: ids, reason } });
    }
  }

  async deliberate(job: DeliberationJob, report: (report: Report) => void, signal: AbortSignal) {
    const seat = seatOf(job.reviewer.agent)!;
    const turn = ROUNDS[seat][job.round - 1] ?? [];
    report({ type: "activity", kind: "status", text: `Round ${job.round}: reading the other findings` });
    if (turn.length === 0) {
      await this.wait(2500, signal);
      report({ type: "activity", kind: "note", text: "Nothing to add this round" });
      return;
    }
    for (const argue of turn) {
      await this.wait(argue.ms * ROUND_PACE, signal);
      const findingId = idOf(job.review, argue.key);
      if (!findingId) continue;
      const answered = argue.replyTo
        ? job.review.arguments.filter((argument) => argument.findingId === findingId && job.review.reviewers.find(({ id }) => id === argument.reviewerId)?.agent === `profile:${argue.replyTo}`).at(-1)
        : undefined;
      report({
        type: "argued",
        argument: { findingId, stance: argue.stance, confidence: argue.confidence, text: fill(job.review, argue.text), evidence: argue.evidence ?? [], ...(answered ? { replyTo: answered.id } : {}) },
      });
    }
  }

  async propose(job: ProposalJob, report: (report: Report) => void, signal: AbortSignal) {
    for (const findingId of job.findingIds) {
      const key = keyOf(job.review, findingId);
      if (!key) continue;
      await this.wait(1600, signal);
      report({ type: "fix-proposed", proposal: { findingId, ...PROPOSALS[key] } });
    }
  }

  async verify(job: VerificationJob, report: (report: Report) => void, signal: AbortSignal) {
    for (const findingId of job.findingIds) {
      const key = keyOf(job.review, findingId);
      if (!key) continue;
      const files = job.review.findings.find(({ id }) => id === findingId)?.fix?.files ?? [];
      report({ type: "activity", kind: "status", text: `Re-checking the fix for ${findingId}` });
      for (const file of files.slice(0, 2)) {
        await this.wait(1100, signal);
        report({ type: "activity", kind: "read", text: `Reading ${file}`, path: file });
      }
      await this.wait(1400, signal);
      report({ type: "fix-checked", check: { findingId, outcome: "verified", ...CHECKS[key] } });
    }
  }
}

/** For the video's plugin host: the scripted runner for the script's seats, nothing for any other agent. */
export function scriptedRunners(clock: Clock, speed = 1) {
  const runner = new ScriptedRunner(clock, speed);
  return (agent: string) => (ScriptedRunner.plays(agent) ? runner : undefined);
}
