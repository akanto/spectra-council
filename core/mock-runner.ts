/**
 * Deterministic mock reviewers, for building the workspace before real agents take part. A mock lists the target's real
 * files, "reads" some of them in its persona's order, and reports findings from its profile's templates against files
 * it read. The same agent, profile, depth and files always give the same script: `mockScript` is pure, and the runner
 * only plays it on a clock.
 */
import type { Clock, DeliberationJob, ProposalJob, Report, ReviewerJob, ReviewerRunner, VerificationJob } from "./engine.ts";
import { argumentsOn, reportersOf, type Argument, type Finding } from "./model.ts";
import type { ProfileId, Evidence, FindingInput, FixCheckInput, ProposalInput, Severity, Confidence, Stance } from "./schemas.ts";

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
  "mock-glm": { pace: 1.1, prefers: /(^|\/)(index|api|types?|schemas?|models?|interfaces?)\.|\.d\.ts$/i, findingBias: 0, habit: "Checking the contracts between modules" },
};

const DEFAULT_PERSONA: Persona = { pace: 1, prefers: /./, findingBias: 0, habit: "Checking the details" };

/**
 * How much a mock does, sized from the review's limit: it reports about half as many findings as allowed (the presets
 * give 2, 3 and 5, as before) and reads about 1.4 files per finding allowed (4, 8 and 14).
 */
const planOf = (maxFindings: number) => ({ reads: Math.max(2, Math.round(maxFindings * 1.4)), findings: Math.ceil(maxFindings / 2) });

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

/**
 * Where a kind of finding lives in the target: one file per title, the same for every persona, so personas who draw the
 * same finding and read that file report it at the same place, as real reviewers who agree do.
 */
const homeOf = (title: string, files: string[]) => files.reduce((best, file) => (hash(`${title}|${file}`) < hash(`${title}|${best}`) ? file : best), files[0] ?? "");

/** The steps one mock reviewer takes over the given files. */
export function mockScript(job: Pick<ReviewerJob, "review" | "reviewer" | "profile">, files: string[]): MockStep[] {
  const { review, reviewer, profile } = job;
  const persona = PERSONAS[reviewer.agent] ?? DEFAULT_PERSONA;
  const next = random(hash(`${reviewer.agent}|${review.profile}|${review.depth}|${files.length}`));
  const plan = planOf(review.maxFindings);
  const pause = (base: number) => Math.round((base + next() * base) * persona.pace);
  const steps: MockStep[] = [];
  const step = (delayMs: number, report: Report) => steps.push({ delayMs, report });
  const activity = (delayMs: number, kind: Extract<Report, { type: "activity" }>["kind"], text: string, path?: string) =>
    step(delayMs, { type: "activity", kind, text, ...(path === undefined ? {} : { path }) });

  const reads = readingOrder(files, persona, plan.reads);
  const pool = [...TEMPLATES[review.profile]];
  const findingCount = Math.max(1, Math.min(pool.length, review.maxFindings, plan.findings + persona.findingBias));
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
        evidence: [{ path: reads.includes(homeOf(template.title, files)) ? homeOf(template.title, files) : file, note: `Where ${reviewer.label} saw it.` }],
        recommendation: template.recommendation,
      };
      activity(pause(500), "status", `Writing up “${template.title}”`);
      step(pause(400), { type: "finding-reported", finding });
    }
  });
  activity(pause(500), "status", "Summarising the review");
  return steps;
}

/** How likely each persona is to back, challenge or be unsure of a finding it didn't report. */
const ODDS: Record<string, [supports: number, challenges: number]> = {
  "mock-claude": [0.6, 0.22],
  "mock-codex": [0.32, 0.5],
  "mock-gemini": [0.4, 0.25],
  "mock-qwen": [0.4, 0.46],
  "mock-glm": [0.5, 0.32],
};
const DEFAULT_ODDS: [number, number] = [0.45, 0.35];

type PickOne = <T>(options: T[]) => T;

/** Fills `{name}` slots of a template. */
const fill = (template: string, slots: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? "");

const SUPPORTS: Record<string, string[]> = {
  "mock-claude": [
    "The tests around {loc} bear this out: {id}, “{title}”, holds.",
    "I cross-checked {loc} against the tests and nothing covers it, so {id} stands.",
  ],
  "mock-codex": [
    "Tracing the call path through {loc} reaches the problem {id} describes. “{title}” is real.",
    "I followed the code to {loc} and it behaves as {id} says.",
  ],
  "mock-gemini": [
    "The docs promise otherwise and {loc} confirms the gap in {id}, “{title}”.",
    "What the docs say and what {loc} does differ, as {id} reports.",
  ],
  "mock-qwen": [
    "I tried the edge cases at {loc} and {id}, “{title}”, shows up on them.",
    "The unusual inputs at {loc} make {id} fail the way it describes.",
  ],
  "mock-glm": [
    "The contract at {loc} promises more than the callers get, which is the gap {id}, “{title}”, names.",
    "I checked what {loc} exports against how it is used, and {id} holds.",
  ],
};

const CHALLENGES: Record<string, string[]> = {
  "mock-claude": [
    "The tests around {loc} cover this, so “{title}” ({id}) does not follow.",
    "{loc} is exercised by a test that would fail if {id} were right.",
  ],
  "mock-codex": [
    "Tracing the call path, {loc} already handles this, so the problem in {id} never arises.",
    "The call at {loc} is guarded two lines later, so the failure {id} describes is handled.",
  ],
  "mock-gemini": [
    "The docs and {loc} disagree with {id}: the behaviour it calls a gap is documented and intended.",
    "{loc} does what the design says it should, so I don't see “{title}” as a problem.",
  ],
  "mock-qwen": [
    "At the edge case in {loc} the value is validated before use, so {id} does not hold.",
    "I tried the empty and oversized inputs at {loc}; both are rejected, which contradicts {id}.",
  ],
  "mock-glm": [
    "The types at {loc} rule out the case {id} describes, so “{title}” can't happen through this interface.",
    "Every caller of {loc} goes through the checked entry point, so {id} does not hold.",
  ],
};

const UNSURE = [
  "I can't tell from {loc} whether {id}, “{title}”, holds; it depends on how callers use it.",
  "{loc} is ambiguous about {id}. I'd need to see the caller before taking a side.",
  "Something is off at {loc}, but I can't say it is the problem {id} names.",
];

const REBUTTALS = [
  "{who}'s objection to {id} misses {loc}: the problem is reached on a path that skips the guard.",
  "The guard {who} points to doesn't cover everything. {loc} shows the case {id} is about.",
  "That answers only part of {id}. At {loc} the failure still happens when the guard is bypassed.",
];

const CONCESSIONS = [
  "Fair point — I withdraw {id}.",
  "{who} is right, and {loc} shows it. I withdraw {id}, “{title}”.",
  "On reflection {id} doesn't hold up against {loc}. I'm dropping it.",
];

const COMES_ROUND = [
  "That answers my objection: {loc} does show the problem. I now back {id}.",
  "I missed the path through {loc}. With it, {id} stands and I withdraw my challenge.",
];

const HOLDS = [
  "The answer on {id} doesn't deal with {loc}: the unchecked path is still reachable. My challenge stands.",
  "Still not convinced by the reply on {id}. {loc} is read without the check, as before.",
];

const RECONSIDERS = [
  "Seeing the evidence others gave on {id}, I take another look at {loc} and now back it.",
  "Having read what the others found on {id}, I withdraw my challenge: {loc} doesn't hold up against them.",
];

const CHECKING = ["Checking {id}'s evidence in {path}", "Weighing {id}: “{title}”", "Re-reading {path} for {id}"];

/** The steps one mock reviewer takes in one deliberation round, from the review as the round starts. */
export function mockDeliberation(job: DeliberationJob): MockStep[] {
  const { review, reviewer, round } = job;
  const persona = PERSONAS[reviewer.agent] ?? DEFAULT_PERSONA;
  const odds = ODDS[reviewer.agent] ?? DEFAULT_ODDS;
  const seed = `${reviewer.agent}|${review.profile}|${review.depth}|${round}|${review.findings.length}`;
  const next = random(hash(seed));
  const pause = (base: number) => Math.round((base + next() * base) * persona.pace);
  const steps: MockStep[] = [];
  const step = (delayMs: number, report: Report) => steps.push({ delayMs, report });
  const pickFrom: PickOne = (options) => options[Math.floor(next() * options.length)]!;
  const nameOf = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;

  const reads = [...new Set(reviewer.activity.flatMap((each) => (each.kind === "read" && each.path ? [each.path] : [])))];
  const evidenceFor = (finding: Finding, note: string): Evidence => {
    const path = pickFrom([...finding.evidence.map((each) => each.path), ...reads]);
    return { path, line: 8 + Math.floor(next() * 140), note };
  };
  const stances = (): Stance => {
    const roll = next();
    return roll < odds[0] ? "supports" : roll < odds[0] + odds[1] ? "challenges" : "uncertain";
  };

  /** Shows the checking, then the argument. */
  const argue = (finding: Finding, evidence: Evidence[], stance: Stance, confidence: Confidence, text: string, replyTo?: string) => {
    const path = evidence[0]?.path ?? finding.evidence[0]?.path ?? "the target";
    step(pause(250), { type: "activity", kind: "status", text: fill(pickFrom(CHECKING), { id: finding.id, title: finding.title, path }) });
    if (evidence[0] && next() < 0.4) step(pause(350), { type: "activity", kind: "read", text: `Reading ${evidence[0].path}`, path: evidence[0].path });
    step(pause(400), { type: "argued", argument: { findingId: finding.id, stance, confidence, text, evidence, ...(replyTo === undefined ? {} : { replyTo }) } });
  };

  const slots = (finding: Finding, evidence: Evidence | undefined, who = ""): Record<string, string> => ({
    id: finding.id,
    title: finding.title,
    loc: evidence ? `${evidence.path}:${evidence.line ?? 1}` : "the code",
    who,
  });
  const textFor = (templates: string[], finding: Finding, evidence: Evidence | undefined, who = "") => fill(pickFrom(templates), slots(finding, evidence, who));
  const forPersona = (table: Record<string, string[]>) => table[reviewer.agent] ?? table["mock-claude"]!;

  for (const finding of review.findings) {
    const own = reportersOf(finding).includes(reviewer.id);
    const mine = argumentsOn(review, finding.id).filter((each) => each.reviewerId === reviewer.id);
    const reporterStance = finding.positions.find((each) => each.reviewerId === finding.reviewerId)?.stance;
    // A finding its reporter conceded is settled; nobody argues about it any more.
    if (reporterStance !== undefined && reporterStance !== "supports") continue;
    const position = finding.positions.find((each) => each.reviewerId === reviewer.id);
    const answered = (argument: Argument) => mine.some((each) => each.replyTo === argument.id);

    if (round === 1) {
      if (own || position) continue;
      const twin = review.findings.find((each) => each.reviewerId === reviewer.id && each.title === finding.title);
      if (twin) {
        argue(finding, twin.evidence, "supports", "high", `I found the same independently in ${twin.id}: “${finding.title}”. ${textFor(forPersona(SUPPORTS), finding, twin.evidence[0])}`);
        continue;
      }
      const stance = stances();
      if (stance === "supports") {
        const evidence = evidenceFor(finding, "Where the problem shows.");
        argue(finding, [evidence], "supports", pickFrom(["medium", "high"] as Confidence[]), textFor(forPersona(SUPPORTS), finding, evidence));
      } else if (stance === "challenges") {
        const evidence = evidenceFor(finding, "Where the claim fails.");
        argue(finding, [evidence], "challenges", pickFrom(["medium", "high"] as Confidence[]), textFor(forPersona(CHALLENGES), finding, evidence));
      } else {
        const evidence = evidenceFor(finding, "What I couldn't settle.");
        argue(finding, [evidence], "uncertain", "low", textFor(UNSURE, finding, evidence));
      }
      continue;
    }

    if (own) {
      const open = argumentsOn(review, finding.id).filter((each) => each.reviewerId !== reviewer.id && each.stance === "challenges" && !answered(each));
      if (open.length === 0) continue;
      // A reporter makes up its mind about a finding once: it defends it every round, or concedes.
      const rebut = random(hash(`${reviewer.agent}|${finding.id}|${finding.title}`))() < 0.75;
      const concedeStance: Stance = next() < 0.5 ? "uncertain" : "challenges";
      for (const challenge of open) {
        const evidence = evidenceFor(finding, rebut ? "Shows the case the guard misses." : "Where the objection holds.");
        const who = nameOf(challenge.reviewerId);
        if (rebut) argue(finding, [evidence], "supports", "high", textFor(REBUTTALS, finding, evidence, who), challenge.id);
        else argue(finding, [], concedeStance, "medium", textFor(CONCESSIONS, finding, evidence, who), challenge.id);
      }
      continue;
    }

    if (position?.stance === "challenges") {
      const rebuttal = argumentsOn(review, finding.id).find((each) => each.reviewerId === finding.reviewerId && each.stance === "supports" && each.replyTo !== undefined && mine.some((m) => m.id === each.replyTo) && !answered(each));
      if (rebuttal) {
        const evidence = evidenceFor(finding, "Where I looked again.");
        if (next() < 0.4) argue(finding, [evidence], "supports", "medium", textFor(COMES_ROUND, finding, evidence), rebuttal.id);
        else argue(finding, [evidence], "challenges", "medium", textFor(HOLDS, finding, evidence), rebuttal.id);
      } else {
        const backing = argumentsOn(review, finding.id).find((each) => each.reviewerId !== reviewer.id && each.stance === "supports" && each.evidence.length > 0);
        const alreadyBacked = mine.at(-1)?.round === round;
        if (backing && !alreadyBacked && !mine.some((each) => each.round >= 2) && next() < 0.2) {
          const evidence = evidenceFor(finding, "Where I looked again.");
          argue(finding, [evidence], "supports", "medium", textFor(RECONSIDERS, finding, evidence));
        }
      }
    } else if (position?.stance === "uncertain") {
      const evidence = evidenceFor(finding, "What settled it.");
      if (next() < 0.55) argue(finding, [evidence], "supports", "medium", textFor(forPersona(SUPPORTS), finding, evidence));
      else argue(finding, [evidence], "challenges", "medium", textFor(forPersona(CHALLENGES), finding, evidence));
    }
  }

  if (steps.length === 0) step(pause(300), { type: "activity", kind: "status", text: `Nothing new to answer in round ${round}` });
  return steps;
}

const unique = <T>(items: T[]) => [...new Set(items)];

const STEP_TEMPLATES = [
  "In {file}: {action}",
  "Update {file} so that {action}",
  "Apply the change in {file}: {action}",
];

const CHECKS = [
  "Add a test in the tests directory that fails before the change and passes after it.",
  "Re-run the existing tests and add one case that drives the path {id} describes.",
  "Review the diff of the touched files against “{title}” and confirm the path is closed.",
];

/** The steps one mock reviewer takes to draft fixes for its findings that stand. */
export function mockProposals(job: ProposalJob): MockStep[] {
  const { review, reviewer } = job;
  const persona = PERSONAS[reviewer.agent] ?? DEFAULT_PERSONA;
  const next = random(hash(`${reviewer.agent}|${review.profile}|${review.depth}|proposals|${job.findingIds.join(",")}`));
  const pause = (base: number) => Math.round((base + next() * base) * persona.pace);
  const pickFrom: PickOne = (options) => options[Math.floor(next() * options.length)]!;
  const nameOf = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const steps: MockStep[] = [];
  const step = (delayMs: number, report: Report) => steps.push({ delayMs, report });

  for (const id of job.findingIds) {
    const finding = review.findings.find((each) => each.id === id);
    if (!finding) continue;
    const template = TEMPLATES[review.profile].find((each) => each.title === finding.title);
    const recommendation = finding.recommendation ?? template?.recommendation ?? "Fix the problem at its source.";
    const action = recommendation.charAt(0).toLowerCase() + recommendation.slice(1).replace(/\.$/, "");
    const cited = argumentsOn(review, id).flatMap((each) => each.evidence.map((e) => e.path));
    const files = unique([...finding.evidence.map((each) => each.path), ...cited]).slice(0, 3);
    if (files.length === 0) files.push("the target");
    const steps_: string[] = [];
    steps_.push(`Reproduce the problem first: ${finding.summary.charAt(0).toLowerCase()}${finding.summary.slice(1)}`.replace(/\.$/, "") + ".");
    files.forEach((file, index) => steps_.push(fill(pickFrom(STEP_TEMPLATES), { file, action: index === 0 ? action : `apply the same change where ${file} is affected` }).replace(/\.$/, "") + "."));
    if (steps_.length < 4 && next() < 0.5) steps_.push("Check the callers of the changed code still behave as before.");

    let risks: string | undefined;
    const dissenters = finding.resolution?.dissenters ?? [];
    if (dissenters.length > 0) {
      risks = dissenters
        .map((dissenter) => {
          const last = argumentsOn(review, id).filter((each) => each.reviewerId === dissenter && each.stance === "challenges").at(-1);
          return last ? `${nameOf(dissenter)} still disputes this: “${last.text}” Confirm that before relying on the change.` : `${nameOf(dissenter)} still disputes this finding; confirm the problem is real before relying on the change.`;
        })
        .join(" ");
    } else if (next() < 0.5) {
      risks = "The change touches code other paths share; run the whole test suite, not only the new test.";
    }

    const proposal: ProposalInput = {
      findingId: id,
      summary: recommendation,
      steps: steps_,
      files: files.filter((file) => file !== "the target"),
      verification: fill(pickFrom(CHECKS), { id, title: finding.title }),
      ...(risks === undefined ? {} : { risks }),
    };
    step(pause(300), { type: "activity", kind: "status", text: `Drafting a fix for ${id}` });
    step(pause(700), { type: "fix-proposed", proposal });
  }
  return steps;
}

const VERIFIED = [
  "I re-read {files} against the fix ({fix}); the path {id} describes is closed.",
  "{files} now does what the fix says ({fix}). Nothing I checked brings {id} back.",
  "Checked {files}: the change matches the recommendation for “{title}”, and the edge I worried about is covered.",
];

const REOPENED = [
  "{files} changed, but the same path is still reachable: the fix ({fix}) covers one caller and not the one at {loc}.",
  "The fix ({fix}) doesn't add the test or guard that would show {id} is closed; {files} reads as before on the risky path.",
  "I re-read {files}: the change moves the problem rather than removing it, so “{title}” still holds.",
];

const WITHOUT_FILES = "the files it names";

/** The steps one mock reviewer takes to re-check the fixes of findings it reported or backed. */
export function mockVerification(job: VerificationJob): MockStep[] {
  const { review, reviewer, pass } = job;
  const persona = PERSONAS[reviewer.agent] ?? DEFAULT_PERSONA;
  const next = random(hash(`${reviewer.agent}|${review.profile}|${review.depth}|verification|${pass}|${job.findingIds.join(",")}`));
  const pause = (base: number) => Math.round((base + next() * base) * persona.pace);
  const pickFrom: PickOne = (options) => options[Math.floor(next() * options.length)]!;
  const steps: MockStep[] = [];
  const step = (delayMs: number, report: Report) => steps.push({ delayMs, report });

  for (const id of job.findingIds) {
    const finding = review.findings.find((each) => each.id === id);
    if (!finding?.fix) continue;
    const { fix } = finding;
    const fixedBefore = fix.checks.some((each) => each.outcome === "reopened");
    // Whether the fix is sound is the fix's, the same for every checker; a checker only now and then sees it otherwise.
    const sound = random(hash(`${review.profile}|${review.depth}|${id}|${finding.title}|${pass}|fix`))() < (fixedBefore ? 0.95 : 0.8);
    const reopen = sound ? next() >= 0.96 : next() < 0.8;
    const file = fix.files[0];
    const evidence: Evidence[] = file ? [{ path: file, line: 5 + Math.floor(next() * 120), note: reopen ? "Where the problem remains." : "Where the fix lands." }] : [];
    const slots = {
      id,
      title: finding.title,
      fix: (fix.summary ?? "the reported change").replace(/\.$/, ""),
      files: fix.files.length > 0 ? fix.files.join(", ") : WITHOUT_FILES,
      loc: evidence[0] ? `${evidence[0].path}:${evidence[0].line}` : WITHOUT_FILES,
    };
    step(pause(250), { type: "activity", kind: "status", text: `Re-checking the fix for ${id}` });
    if (file) step(pause(350), { type: "activity", kind: "read", text: `Reading ${file}`, path: file });
    const check: FixCheckInput = { findingId: id, outcome: reopen ? "reopened" : "verified", text: fill(pickFrom(reopen ? REOPENED : VERIFIED), slots), evidence };
    step(pause(500), { type: "fix-checked", check });
  }
  if (steps.length === 0) step(pause(300), { type: "activity", kind: "status", text: "No fixes to re-check" });
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

  async deliberate(job: DeliberationJob, report: (report: Report) => void, signal: AbortSignal) {
    for (const { delayMs, report: each } of mockDeliberation(job)) {
      await this.clock.sleep(delayMs, signal);
      report(each);
    }
  }

  async propose(job: ProposalJob, report: (report: Report) => void, signal: AbortSignal) {
    for (const { delayMs, report: each } of mockProposals(job)) {
      await this.clock.sleep(delayMs, signal);
      report(each);
    }
  }

  async verify(job: VerificationJob, report: (report: Report) => void, signal: AbortSignal) {
    for (const { delayMs, report: each } of mockVerification(job)) {
      await this.clock.sleep(delayMs, signal);
      report(each);
    }
  }
}
