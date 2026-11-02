/**
 * Runs a review: starts every seated reviewer at once through a runner, applies what they report, and ends the review
 * when they are all done or the user stops it. Knows nothing of hosts or views: the host hands in a runner, a clock and
 * a listener, and draws or stores each new review the listener gets.
 */
import { isRunning, seatedReviewers, type Review, type Reviewer } from "./model.ts";
import { PROFILES, type ReviewProfile } from "./profiles.ts";
import { reduce, type ReviewEvent, type ReviewerEvent } from "./review.ts";
import { findingInputSchema, problemsOf } from "./schemas.ts";

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

/** What a reviewer's runner reports; the session fills in the reviewer and the time. */
export type Report =
  | { type: "activity"; kind: Extract<ReviewerEvent, { type: "activity" }>["kind"]; text: string; path?: string }
  | { type: "finding-reported"; finding: unknown };

/**
 * Runs one reviewer to the end: resolves when it finished its review, rejects when it failed. It stops soon after the
 * signal aborts. A runner never ends the reviewer itself: the session does, from how `run` settles.
 */
export interface ReviewerRunner {
  run(job: ReviewerJob, report: (report: Report) => void, signal: AbortSignal): Promise<void>;
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

  /** Starts the review; resolves with the review once every reviewer is done or the review was stopped. */
  async run(): Promise<Review> {
    this.#dispatch({ type: "started", at: this.#clock.now() });
    const profile = PROFILES[this.#review.profile];
    const started = this.#review;
    await Promise.all(seatedReviewers(started).map((reviewer) => this.#runReviewer({ review: started, reviewer, profile })));
    return this.#review;
  }

  async #runReviewer(job: ReviewerJob) {
    const reviewerId = job.reviewer.id;
    const at = () => this.#clock.now();
    const signal = this.#abort.signal;
    this.#dispatch({ type: "reviewer-started", reviewerId, at: at() });
    const report = (report: Report) => {
      if (signal.aborted) return;
      if (report.type === "activity") {
        this.#dispatch({ type: "activity", reviewerId, at: at(), kind: report.kind, text: report.text, ...(report.path === undefined ? {} : { path: report.path }) });
        return;
      }
      const parsed = findingInputSchema.safeParse(report.finding);
      if (parsed.success) this.#dispatch({ type: "finding-reported", reviewerId, at: at(), finding: parsed.data });
      else this.#dispatch({ type: "activity", reviewerId, at: at(), kind: "error", text: `Rejected a malformed finding: ${problemsOf(parsed.error)}` });
    };
    try {
      await this.#runner.run(job, report, signal);
      this.#dispatch({ type: "reviewer-finished", reviewerId, at: at(), outcome: signal.aborted ? "stopped" : "completed" });
    } catch (error) {
      const outcome = signal.aborted ? "stopped" : "failed";
      const problem = outcome === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined;
      this.#dispatch({ type: "reviewer-finished", reviewerId, at: at(), outcome, ...(problem === undefined ? {} : { problem }) });
    }
  }

  /** Stops every reviewer; the review ends as stopped. */
  stop() {
    if (!isRunning(this.#review)) return;
    this.#dispatch({ type: "stopped", at: this.#clock.now() });
    this.#abort.abort(new Error("The review was stopped."));
  }
}
