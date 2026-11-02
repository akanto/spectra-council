/**
 * Runs a review: starts every seated reviewer at once through a runner, applies what they report, then has the ones that
 * finished deliberate over the findings in rounds, settles each finding and concludes with a verdict. Ends early when
 * the user stops it. Knows nothing of hosts or views: the host hands in a runner, a clock and a listener, and draws or
 * stores each new review the listener gets.
 */
import { checkersOf, ROUNDS, settle, verdictSummary } from "./deliberation.ts";
import { isRunning, isStanding, seatedReviewers, type Review, type Reviewer } from "./model.ts";
import { PROFILES, type ReviewProfile } from "./profiles.ts";
import { reduce, type ReviewEvent, type ReviewerEvent } from "./review.ts";
import { argumentInputSchema, findingInputSchema, fixCheckInputSchema, problemsOf, proposalInputSchema } from "./schemas.ts";

/** How long the synthesis takes over each finding, so the user sees the verdicts come in. */
export const SYNTHESIS_PAUSE_MS = 400;

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

/** What a runner gets for one reviewer. */
export interface ReviewerJob {
  review: Review;
  reviewer: Reviewer;
  profile: ReviewProfile;
}

/**
 * What a runner gets for one reviewer's turn in a deliberation round. `review` is the review as the round starts: every
 * finding with its positions, and every argument so far (`argumentsOn(review, id)` gives one finding's timeline).
 */
export interface DeliberationJob extends ReviewerJob {
  round: number;
  rounds: number;
}

/**
 * What a reviewer's runner reports; the session fills in the reviewer and the time. A finding is reported in the
 * independent review, an argument in a deliberation round; both are validated, and a malformed one shows as an error.
 */
export type Report =
  | { type: "activity"; kind: Extract<ReviewerEvent, { type: "activity" }>["kind"]; text: string; path?: string }
  | { type: "finding-reported"; finding: unknown }
  | { type: "argued"; argument: unknown }
  | { type: "fix-proposed"; proposal: unknown }
  | { type: "fix-checked"; check: unknown };

/**
 * What a runner gets to propose fixes, in the synthesis: the findings this reviewer reported that stand, settled, with
 * the whole deliberation in `review`.
 */
export interface ProposalJob extends ReviewerJob {
  findingIds: string[];
}

/**
 * What a runner gets to re-check fixes in a verification round: the fixed findings this reviewer reported or backed;
 * each finding's `fix` says what the agent changed and where.
 */
export interface VerificationJob extends ReviewerJob {
  findingIds: string[];
  /** The verification round, 1-based. */
  pass: number;
}

/**
 * Runs reviewers. Each call resolves when the reviewer is done with its part and rejects when it failed; it stops soon
 * after the signal aborts. A runner never ends the reviewer itself: the session does, from how the call settles.
 */
export interface ReviewerRunner {
  /** The reviewer's own review, without seeing anyone else's findings. */
  run(job: ReviewerJob, report: (report: Report) => void, signal: AbortSignal): Promise<void>;
  /** The reviewer's turn in one deliberation round: it argues about any of the findings, its own included. */
  deliberate(job: DeliberationJob, report: (report: Report) => void, signal: AbortSignal): Promise<void>;
  /** Drafts a fix for each of the given findings, reporting one "fix-proposed" each. */
  propose(job: ProposalJob, report: (report: Report) => void, signal: AbortSignal): Promise<void>;
  /** Re-checks the fixes of the given findings, reporting one "fix-checked" each. */
  verify(job: VerificationJob, report: (report: Report) => void, signal: AbortSignal): Promise<void>;
}

/** How an agent's turn in a conversation ended: its last message, if it said anything in words. */
export interface AgentReply {
  conversationId: string;
  /** The profile's name as the host has it. */
  profile: string;
  text: string | null;
  ended: "finished" | "stopped" | "failed";
}

/**
 * Conversations with real agents, as a host gives them: each `ask` starts a fresh conversation on a profile with the
 * prompt as its first message and resolves once that turn ends. It rejects when the conversation can't start (no
 * profile of that name, or no way to start one now) and as soon as the signal aborts; a host that can't stop the
 * conversation lets it run on and ignores its reply.
 */
export interface Conversations {
  ask(request: { profile: string; prompt: string; signal: AbortSignal; onStart?: (conversationId: string) => void }): Promise<AgentReply>;
}

/** How long a real reviewer's turn may take before its seat gives up on it. */
export const TURN_LIMIT_MS = 15 * 60_000;

/** A runner that sends each reviewer to `byAgent(reviewer.agent)`, so mocks and real agents can sit at one council. */
export function routeByAgent(byAgent: (agent: string) => ReviewerRunner): ReviewerRunner {
  return {
    run: (job, report, signal) => byAgent(job.reviewer.agent).run(job, report, signal),
    deliberate: (job, report, signal) => byAgent(job.reviewer.agent).deliberate(job, report, signal),
    propose: (job, report, signal) => byAgent(job.reviewer.agent).propose(job, report, signal),
    verify: (job, report, signal) => byAgent(job.reviewer.agent).verify(job, report, signal),
  };
}

export interface SessionOptions {
  runner: ReviewerRunner;
  clock?: Clock;
  /** Hears every new review, after each event. */
  onChange(review: Review): void;
}

export class ReviewSession {
  #review: Review;
  readonly #runner: ReviewerRunner;
  readonly #clock: Clock;
  readonly #onChange: (review: Review) => void;
  readonly #abort = new AbortController();

  constructor(review: Review, { runner, clock = systemClock, onChange }: SessionOptions) {
    this.#review = review;
    this.#runner = runner;
    this.#clock = clock;
    this.#onChange = onChange;
  }

  get review() {
    return this.#review;
  }

  #dispatch(event: ReviewEvent) {
    const next = reduce(this.#review, event);
    if (next === this.#review) return;
    this.#review = next;
    this.#onChange(next);
  }

  /** Runs the review to its verdict; resolves with the review once it concluded or was stopped. */
  async run(): Promise<Review> {
    this.#dispatch({ type: "started", at: this.#clock.now() });
    const profile = PROFILES[this.#review.profile];
    const started = this.#review;
    await Promise.all(seatedReviewers(started).map((reviewer) => this.#runReviewer({ review: started, reviewer, profile })));
    if (!isRunning(this.#review)) return this.#review;

    const finished = seatedReviewers(this.#review).filter((reviewer) => reviewer.status === "completed");
    if (finished.length >= 2 && this.#review.findings.length > 0) {
      if (!(await this.#deliberate(profile))) return this.#review;
    }
    this.#dispatch({ type: "concluded", at: this.#clock.now(), summary: verdictSummary(this.#review) });
    return this.#review;
  }

  /** The rounds and the synthesis; false when the review was stopped on the way. */
  async #deliberate(profile: ReviewProfile): Promise<boolean> {
    const signal = this.#abort.signal;
    const rounds = ROUNDS[this.#review.depth];
    this.#dispatch({ type: "deliberation-started", at: this.#clock.now(), rounds });
    for (let round = 1; round <= rounds; round++) {
      if (signal.aborted) return false;
      this.#dispatch({ type: "round-started", at: this.#clock.now(), round });
      const table = this.#review;
      const sitting = seatedReviewers(table).filter((reviewer) => reviewer.status === "deliberating");
      if (sitting.length === 0) break;
      await Promise.all(sitting.map((reviewer) => this.#deliberateOne({ review: table, reviewer, profile, round, rounds })));
    }
    if (signal.aborted) return false;
    this.#dispatch({ type: "synthesis-started", at: this.#clock.now() });
    for (const { id } of this.#review.findings) {
      try {
        await this.#clock.sleep(SYNTHESIS_PAUSE_MS, signal);
      } catch {
        return false;
      }
      const finding = this.#review.findings.find((each) => each.id === id)!;
      this.#dispatch({ type: "finding-resolved", at: this.#clock.now(), findingId: id, ...settle(this.#review, finding) });
    }
    // Each reporter drafts the fixes for its findings that stand, all at once.
    const settled = this.#review;
    const drafters = seatedReviewers(settled).filter((reviewer) => reviewer.status === "deliberating");
    await Promise.all(
      drafters.map((reviewer) => {
        const findingIds = settled.findings.filter((finding) => finding.reviewerId === reviewer.id && isStanding(finding)).map(({ id }) => id);
        if (findingIds.length === 0) return;
        return this.#aside(reviewer.id, "proposing fixes", () => this.#runner.propose({ review: settled, reviewer, profile, findingIds }, this.#reporter(reviewer.id), signal));
      }),
    );
    return !signal.aborted;
  }

  /**
   * Re-checks every fixed finding: each is checked by its reporter and the reviewers who backed it, all at once. Run on a
   * complete review; resolves with it complete again (or stopped short).
   */
  async verify(): Promise<Review> {
    const review = this.#review;
    const profile = PROFILES[review.profile];
    const fixed = review.findings.filter((finding) => finding.fix?.state === "fixed");
    const assignments = new Map<string, string[]>();
    for (const finding of fixed) for (const reviewer of checkersOf(review, finding)) assignments.set(reviewer.id, [...(assignments.get(reviewer.id) ?? []), finding.id]);
    this.#dispatch({ type: "verification-started", at: this.#clock.now(), findingIds: fixed.map(({ id }) => id), reviewerIds: [...assignments.keys()] });
    const started = this.#review;
    const pass = started.verifications;
    await Promise.all(
      [...assignments].map(([reviewerId, findingIds]) => {
        const reviewer = started.reviewers.find(({ id }) => id === reviewerId)!;
        return this.#aside(reviewerId, "re-checking fixes", () => this.#runner.verify({ review: started, reviewer, profile, findingIds, pass }, this.#reporter(reviewerId), this.#abort.signal));
      }),
    );
    if (this.#abort.signal.aborted) return this.#review;
    this.#dispatch({ type: "verification-ended", at: this.#clock.now() });
    return this.#review;
  }

  /** Runs work that shouldn't end the reviewer when it fails: the failure shows in its activity instead. */
  async #aside(reviewerId: string, what: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      const problem = error instanceof Error ? error.message : String(error);
      this.#dispatch({ type: "activity", reviewerId, at: this.#clock.now(), kind: "error", text: `Failed ${what}: ${problem}` });
    }
  }

  /** What a reviewer reports, checked and applied; a malformed report shows as an error in its activity. */
  #reporter(reviewerId: string) {
    const signal = this.#abort.signal;
    const at = () => this.#clock.now();
    const rejected = (what: string, problem: string) => this.#dispatch({ type: "activity", reviewerId, at: at(), kind: "error", text: `Rejected a malformed ${what}: ${problem}` });
    return (report: Report) => {
      if (signal.aborted) return;
      switch (report.type) {
        case "activity":
          this.#dispatch({ type: "activity", reviewerId, at: at(), kind: report.kind, text: report.text, ...(report.path === undefined ? {} : { path: report.path }) });
          return;
        case "finding-reported": {
          const parsed = findingInputSchema.safeParse(report.finding);
          if (parsed.success) this.#dispatch({ type: "finding-reported", reviewerId, at: at(), finding: parsed.data });
          else rejected("finding", problemsOf(parsed.error));
          return;
        }
        case "argued": {
          const parsed = argumentInputSchema.safeParse(report.argument);
          if (!parsed.success) return rejected("argument", problemsOf(parsed.error));
          const { findingId, replyTo } = parsed.data;
          if (!this.#review.findings.some(({ id }) => id === findingId)) return rejected("argument", `there is no finding ${findingId}`);
          if (replyTo !== undefined && !this.#review.arguments.some(({ id }) => id === replyTo)) return rejected("argument", `there is no argument ${replyTo}`);
          this.#dispatch({ type: "argued", reviewerId, at: at(), argument: parsed.data });
          return;
        }
        case "fix-proposed": {
          const parsed = proposalInputSchema.safeParse(report.proposal);
          if (!parsed.success) return rejected("fix proposal", problemsOf(parsed.error));
          const finding = this.#review.findings.find(({ id }) => id === parsed.data.findingId);
          if (!finding || !isStanding(finding)) return rejected("fix proposal", `${parsed.data.findingId} isn't a finding that stands`);
          this.#dispatch({ type: "fix-proposed", reviewerId, at: at(), proposal: parsed.data });
          return;
        }
        case "fix-checked": {
          const parsed = fixCheckInputSchema.safeParse(report.check);
          if (!parsed.success) return rejected("fix check", problemsOf(parsed.error));
          const finding = this.#review.findings.find(({ id }) => id === parsed.data.findingId);
          if (finding?.fix?.state !== "fixed") return rejected("fix check", `${parsed.data.findingId} has no fix to re-check`);
          this.#dispatch({ type: "fix-checked", reviewerId, at: at(), check: parsed.data });
          return;
        }
      }
    };
  }

  /** Runs one part of a reviewer's work; a failure ends the reviewer as failed, a stop leaves it to the stop. */
  async #attempt(reviewerId: string, work: () => Promise<void>, finishOnSuccess: boolean) {
    const signal = this.#abort.signal;
    const at = () => this.#clock.now();
    try {
      await work();
      if (finishOnSuccess || signal.aborted) this.#dispatch({ type: "reviewer-finished", reviewerId, at: at(), outcome: signal.aborted ? "stopped" : "completed" });
    } catch (error) {
      const outcome = signal.aborted ? "stopped" : "failed";
      const problem = outcome === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined;
      this.#dispatch({ type: "reviewer-finished", reviewerId, at: at(), outcome, ...(problem === undefined ? {} : { problem }) });
    }
  }

  async #runReviewer(job: ReviewerJob) {
    const reviewerId = job.reviewer.id;
    this.#dispatch({ type: "reviewer-started", reviewerId, at: this.#clock.now() });
    await this.#attempt(reviewerId, () => this.#runner.run(job, this.#reporter(reviewerId), this.#abort.signal), true);
  }

  async #deliberateOne(job: DeliberationJob) {
    const reviewerId = job.reviewer.id;
    await this.#attempt(reviewerId, () => this.#runner.deliberate(job, this.#reporter(reviewerId), this.#abort.signal), false);
  }

  /** Stops every reviewer; the review ends as stopped. */
  stop() {
    if (!isRunning(this.#review)) return;
    this.#dispatch({ type: "stopped", at: this.#clock.now() });
    this.#abort.abort(new Error("The review was stopped."));
  }
}
