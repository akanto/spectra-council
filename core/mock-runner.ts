/**
 * Deterministic mock reviewers, for building the workspace before real agents take part. A mock lists the target's real
 * files, "reads" some of them in its persona's order, and reports findings from its profile's templates against files
 * it read. The same agent, profile, depth and files always give the same script: `mockScript` is pure, and the runner
 * only plays it on a clock.
 */
import type { Clock, Report, ReviewerJob, ReviewerRunner } from "./engine.ts";
import type { ProfileId, Depth, FindingInput, Severity, Confidence } from "./schemas.ts";

/** Lists a review target's files, relative to it, for a mock to pick from. */
export type FileLister = (target: string) => Promise<string[]>;

export interface MockStep {
  /** How long the mock works before this step shows. */
  delayMs: number;
  report: Report;
}

interface Persona {
  /** Slower than 1 takes longer over each step. */
  pace: number;
  /** Files it reads first. */
  prefers: RegExp;
  /** More or fewer findings than the depth's usual. */
  findingBias: number;
  /** How it phrases its own checks. */
  habit: string;
}

const PERSONAS: Record<string, Persona> = {
  "mock-claude": { pace: 1, prefers: /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\./i, findingBias: 0, habit: "Cross-checking against the tests" },
  "mock-codex": { pace: 0.7, prefers: /\.(ts|tsx|js|py|go|rs|java|kt|c|cc|cpp|swift|rb)$/i, findingBias: -1, habit: "Tracing the main code path" },
  "mock-gemini": { pace: 0.9, prefers: /\.(md|tex|json|ya?ml|toml|ini|cfg)$|(^|\/)docs?\//i, findingBias: 0, habit: "Comparing the docs with the code" },
  "mock-qwen": { pace: 1.4, prefers: /./, findingBias: 1, habit: "Checking edge cases" },
};

const DEFAULT_PERSONA: Persona = { pace: 1, prefers: /./, findingBias: 0, habit: "Checking the details" };

const DEPTH_PLAN: Record<Depth, { reads: number; findings: number }> = {
  quick: { reads: 4, findings: 2 },
  standard: { reads: 8, findings: 3 },
  deep: { reads: 14, findings: 5 },
};

interface Template {
  title: string;
  summary: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  recommendation: string;
}

const t = (title: string, category: string, severity: Severity, confidence: Confidence, summary: string, recommendation: string): Template => ({
  title,
  summary,
  category,
  severity,
  confidence,
  recommendation,
});

/** Each profile's findings. Several reviewers often draw the same one, as real reviewers often agree. */
const TEMPLATES: Record<ProfileId, Template[]> = {
  general: [
    t("Unclear ownership of shared state", "clarity", "medium", "medium", "Several parts change the same state without one place that owns it, so its invariants are hard to see.", "Give the state one owner and route changes through it."),
    t("Undocumented failure behaviour", "completeness", "medium", "high", "What happens when this step fails is not written down, and the code does not make it obvious.", "Document the failure modes next to the code that handles them."),
    t("Hard-coded configuration", "risk", "low", "high", "Values that differ between environments are fixed in the source.", "Read them from configuration with checked defaults."),
    t("Inconsistent naming", "clarity", "info", "medium", "The same concept goes by different names here, which makes the code harder to search and review.", "Pick one name and use it throughout."),
    t("Missing input validation", "correctness", "high", "medium", "Input from outside is used before it is checked, so a malformed value fails deep inside.", "Validate at the boundary and report what is wrong."),
    t("Silent error swallowing", "risk", "high", "high", "An error is caught and dropped, so failures go unnoticed until something downstream breaks.", "Log or surface the error, or let it propagate."),
  ],
  code: [
    t("Unhandled promise rejection", "error-handling", "high", "high", "An async call is neither awaited nor given a catch, so its failure is lost.", "Await it, or attach a handler that reports the failure."),
    t("Race on shared mutable state", "concurrency", "high", "medium", "Two concurrent paths read and write the same value without ordering, so the last writer wins unpredictably.", "Serialize the updates or make the state immutable."),
    t("Off-by-one in range handling", "correctness", "medium", "medium", "The loop bound and the slice end disagree on inclusivity, which drops or repeats one element at the edge.", "Use one convention for ranges and test both edges."),
    t("Risky path has no test", "testing", "medium", "high", "The branch that handles the rare case has no test, so a regression there would pass CI.", "Add a test that drives that branch."),
    t("Function does too many things", "maintainability", "low", "high", "One function parses, validates, decides and writes, which makes each part hard to change alone.", "Split it along those steps."),
    t("Quadratic lookup in a loop", "performance", "medium", "medium", "A linear search runs inside a loop over the same collection, which grows quadratically with input size.", "Build an index (a Map) once before the loop."),
  ],
  architecture: [
    t("Unsupported scalability assumption", "scalability", "high", "medium", "The design assumes one instance holds all state in memory; nothing says what happens past one machine.", "State the expected load, and how the design scales or where it stops."),
    t("Missing failure scenario", "resilience", "high", "high", "There is no account of what happens when the downstream service is slow or down: no timeout, retry or fallback.", "Define timeouts, retries with backoff, and the degraded behaviour."),
    t("Core logic depends on the UI layer", "boundaries", "medium", "high", "Domain code imports presentation code, so it can't be reused or tested without the UI.", "Invert the dependency: the UI depends on the core, not the other way."),
    t("Two modules share a data model implicitly", "coupling", "medium", "medium", "Both modules read the same persisted shape without a shared type, so a change in one silently breaks the other.", "Give the shape one definition both import."),
    t("No observability for the critical path", "operability", "medium", "medium", "The path that matters most has no metrics or structured logs, so incidents would be diagnosed blind.", "Add timings and outcome counts on that path."),
    t("Schema evolution not planned", "data-model", "low", "medium", "Stored data has no version, so a future change in its shape can't tell old records from new.", "Version the stored format and migrate on read."),
  ],
  security: [
    t("User input reaches a shell command", "injection", "critical", "medium", "A value from outside is interpolated into a command line, which allows command injection.", "Pass arguments as an array without a shell, or validate against an allow-list."),
    t("Missing authorization check", "authz", "high", "medium", "The handler checks that the caller is signed in but not that they may act on this resource.", "Check ownership or role before acting."),
    t("Secret committed to the repository", "secrets", "high", "low", "A value that looks like a credential is in a tracked file.", "Rotate it, remove it from history, and load it from the environment."),
    t("Weak randomness for a token", "crypto", "medium", "high", "A token is made with a non-cryptographic random generator.", "Use crypto.getRandomValues or the platform's CSPRNG."),
    t("Outdated dependency with known issues", "dependencies", "medium", "low", "A pinned dependency is several releases behind, and later releases fix security issues.", "Upgrade and add automated dependency checks."),
    t("Permissive default configuration", "configuration", "low", "medium", "The default binds to all interfaces and allows any origin.", "Default to localhost and an explicit origin list."),
  ],
  scientific: [
    t("Possible experimental data leakage", "data-leakage", "critical", "medium", "Normalisation statistics appear to be computed on the full dataset before the split, so test information leaks into training.", "Fit preprocessing on the training split only."),
    t("Possible experimental bias", "methodology", "high", "medium", "Baselines are tuned less than the proposed method, which favours it.", "Give every method the same tuning budget, and report it."),
    t("No variance reported across seeds", "statistics", "medium", "high", "Results are single runs; the improvement may be within run-to-run noise.", "Report mean and spread over several seeds, with a significance test."),
    t("Claim outruns the evidence", "claims", "high", "medium", "The text generalises beyond the datasets evaluated.", "Narrow the claim or add evaluations that support it."),
    t("Results not reproducible from the repository", "reproducibility", "medium", "high", "The exact configuration and data version behind the reported numbers are not recorded.", "Commit the configs and a script that regenerates each table."),
    t("Missing comparison with closest prior work", "related-work", "low", "medium", "The most similar published method is cited but not compared against.", "Add it as a baseline or explain why it doesn't apply."),
  ],
};

/** FNV-1a, for a seed from text. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so the scripts are the same on every run. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The files a persona reads, its favourites first, each part kept in path order. */
function readingOrder(files: string[], persona: Persona, count: number): string[] {
  const sorted = [...files].sort();
  const favourites = sorted.filter((file) => persona.prefers.test(file));
  const others = sorted.filter((file) => !persona.prefers.test(file));
  return [...favourites, ...others].slice(0, count);
}

/** The steps one mock reviewer takes over the given files. */
export function mockScript(job: Pick<ReviewerJob, "review" | "reviewer" | "profile">, files: string[]): MockStep[] {
  const { review, reviewer, profile } = job;
  const persona = PERSONAS[reviewer.agent] ?? DEFAULT_PERSONA;
  const next = random(hash(`${reviewer.agent}|${review.profile}|${review.depth}|${files.length}`));
  const plan = DEPTH_PLAN[review.depth];
  const pause = (base: number) => Math.round((base + next() * base) * persona.pace);
  const steps: MockStep[] = [];
  const step = (delayMs: number, report: Report) => steps.push({ delayMs, report });
  const activity = (delayMs: number, kind: Extract<Report, { type: "activity" }>["kind"], text: string, path?: string) =>
    step(delayMs, { type: "activity", kind, text, ...(path === undefined ? {} : { path }) });

  const reads = readingOrder(files, persona, plan.reads);
  const pool = [...TEMPLATES[review.profile]];
  const findingCount = Math.max(1, Math.min(pool.length, plan.findings + persona.findingBias));
  // Which reads a finding follows: spread over the review, not the first read unless it is the only one.
  const first = reads.length > 1 ? 1 : 0;
  const span = reads.length - first;
  const findingAfter = new Set<number>();
  while (findingAfter.size < Math.min(findingCount, span)) findingAfter.add(first + Math.floor(next() * span));

  activity(pause(300), "status", `Planning a ${profile.title.toLowerCase()} review`);
  activity(pause(400), "tool", `Listing files (${files.length} found)`);
  reads.forEach((file, index) => {
    activity(pause(600), "read", `Reading ${file}`, file);
    if (index % 3 === 2) activity(pause(400), "search", `Searching for ${profile.focus[index % profile.focus.length]!.toLowerCase()}`);
    if (index % 4 === 1) activity(pause(300), "note", persona.habit);
    if (findingAfter.has(index) && pool.length > 0) {
      const template = pool.splice(Math.floor(next() * pool.length), 1)[0]!;
      const finding: FindingInput = {
        title: template.title,
        summary: template.summary,
        severity: template.severity,
        confidence: template.confidence,
        category: template.category,
        evidence: [{ path: file, note: `Where ${reviewer.label} saw it.` }],
        recommendation: template.recommendation,
      };
      activity(pause(500), "status", `Writing up “${template.title}”`);
      step(pause(400), { type: "finding-reported", finding });
    }
  });
  activity(pause(500), "status", "Summarising the review");
  return steps;
}

/** Plays mock scripts on a clock. */
export class MockRunner implements ReviewerRunner {
  constructor(
    private readonly listFiles: FileLister,
    private readonly clock: Clock,
  ) {}

  async run(job: ReviewerJob, report: (report: Report) => void, signal: AbortSignal) {
    const files = await this.listFiles(job.review.target);
    if (files.length === 0) throw new Error(`There are no files to review in ${job.review.target}.`);
    for (const { delayMs, report: each } of mockScript(job, files)) {
      await this.clock.sleep(delayMs, signal);
      report(each);
    }
  }
}
