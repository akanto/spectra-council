/**
 * The prompts a real agent gets, one per turn of a review: its independent review, the grouping of duplicate findings,
 * a deliberation round, the fix proposals and the re-check of fixes. Each stands on its own (the agent sees nothing else) and ends by asking for the
 * reply as a ```json block, which agent-runner.ts reads. Pure: the same job gives the same prompt.
 */
import { z } from "zod";
import type { DeliberationJob, DraftCheckJob, DraftJob, ProposalJob, ReviewerJob, SourceCheckJob, VerificationJob } from "./engine.ts";
import { claimReportersOf, claimsOf, isClaimStanding, reportersOf, type Argument, type Claim, type Finding, type Review } from "./model.ts";
import { currentClaims } from "./research.ts";
import {
  argumentInputSchema,
  claimGroupInputSchema,
  claimInputSchema,
  draftObjectionInputSchema,
  sourceCheckInputSchema,
  duplicateGroupInputSchema,
  type Evidence,
  findingInputSchema,
  fixCheckInputSchema,
  proposalInputSchema,
} from "./schemas.ts";

const schemaOf = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema), null, 2);

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

/** Finding ids as a title shows them: the first three, then how many more. */
export const idsInTitle = (ids: string[]) => (ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} +${ids.length - 3}`);

/**
 * The first line of every prompt the council sends, which Mirador takes for the conversation's title (its first 60
 * characters): the review, then the task, then who does it, so a cut drops the least telling part.
 */
export const turnTitle = (review: Pick<Review, "id">, task: string, who?: string) => ["Spectra Council " + review.id, task, ...(who ? [who] : [])].join(" · ");

/** A prompt's title: its first line, which is `turnTitle`'s for every prompt the council sends. */
export const promptTitle = (prompt: string) => prompt.split("\n", 1)[0]!.trim();

/** The common start of every turn: who the reviewer is, the rules, the profile's brief and the user's instructions. */
function header({ review, reviewer, profile }: ReviewerJob, task: string): string {
  const parts = [
    turnTitle(review, task, reviewer.label),
    `You are reviewer ${reviewer.id}, one independent reviewer on a Spectra Council review of this target: ${review.target}`,
    "The target may be a folder or one file. Evidence paths are relative to the target folder (for a file target, the folder holding it).",
    "You are read-only: read and search the target, but don't change any file, and don't run commands that write or install anything.",
    `Review profile: ${profile.title}. ${profile.brief}`,
    `Focus on:\n${bullets(profile.focus)}`,
    `Categories for findings: ${profile.categories.join(", ")}.`,
  ];
  const instructions = review.instructions.trim();
  if (instructions) parts.push(`The user's instructions:\n${instructions}`);
  return parts.join("\n\n");
}

/** How to end: the reply shape, the item's JSON Schema and an example. Nothing may follow the block. */
function ending(what: string, shape: string, itemName: string, schema: z.ZodType, example: unknown): string {
  return [
    `End your final message with one \`\`\`json block holding ${what}, in this shape: ${shape}. Nothing after the block. You may write one short sentence of plain prose before it, with no Markdown links.`,
    `Each ${itemName} must fit this JSON Schema:\n\`\`\`\n${schemaOf(schema)}\n\`\`\``,
    `Example:\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``,
  ].join("\n\n");
}

const evidenceLine = (e: Evidence) => `${e.path}${e.line ? `:${e.line}${e.endLine ? `-${e.endLine}` : ""}` : ""}${e.quote ? ` "${e.quote}"` : ""}${e.note ? ` (${e.note})` : ""}`;
const evidenceText = (evidence: Evidence[]) => (evidence.length === 0 ? "none" : evidence.map(evidenceLine).join("; "));

/** Multi-line text (Markdown paragraphs and lists) indented under its label, with no blank lines inside an item. */
const indented = (text: string, by: string) => text.trim().replace(/\n\s*\n/g, "\n").replace(/\n/g, `\n${by}`);

function findingText(finding: Finding, review: Review): string {
  return [
    `${finding.id} reported by ${finding.reviewerId}: ${finding.title}`,
    `  severity ${finding.severity}, confidence ${finding.confidence}, category ${finding.category}`,
    `  summary: ${indented(finding.summary, "    ")}`,
    `  evidence: ${evidenceText(finding.evidence)}`,
    ...(finding.recommendation ? [`  recommendation: ${indented(finding.recommendation, "    ")}`] : []),
  ].join("\n");
}

const argumentText = (a: Argument, by = "  ") =>
  `${a.id} [round ${a.round}] ${a.reviewerId} on ${a.findingId}, ${a.stance} (${a.confidence})${a.replyTo ? `, replying to ${a.replyTo}` : ""}: ${indented(a.text, by)}${a.evidence.length > 0 ? `\n${by}Evidence: ${evidenceText(a.evidence)}` : ""}`;

const findingsById = (review: Review, ids: string[]) => ids.flatMap((id) => review.findings.filter((finding) => finding.id === id));

/**
 * How a finding should read: people who never saw the code rule on it, so it leads with the impact in plain words, keeps
 * one defect per finding, and uses the Markdown subset the view renders.
 */
export const WRITING_FINDINGS = [
  "How to write each finding (a person who doesn't know the code reads it and decides what to do):",
  bullets([
    "Title: the problem as the user would notice it, in a few plain words, not a function name.",
    "Summary, first sentence: the impact in plain language: what goes wrong for the user or the system, and when. No code names in it.",
    "Then, after a blank line, the cause in a few short sentences; put code names in `backticks` and only where they help. The full file and line details go in the evidence; in the text, cite a place as path:line only where it helps the reader.",
    "Where it helps, the scenario as a short bullet list of steps that ends in the wrong result.",
    "One defect per finding. If you found several problems, report each as its own finding; don't chain them with \"Moreover\" or \"Also\".",
    "Recommendation: the fix in a sentence or a short bullet list.",
    "Formatting: Markdown with inline `code`, **bold**, paragraphs and - bullet lists only; no headings, tables, code blocks or HTML. Cite places as path:line, e.g. src/server.ts:42.",
    "Inside the JSON strings, write each line break as \\n (a raw line break makes the JSON unreadable).",
  ]),
].join("\n");

export function reviewPrompt(job: ReviewerJob): string {
  const task = [
    "Your task: review the target on your own and report the problems that matter, each with evidence: a path (and a line where you can) and a short quote. Don't pad the list; an empty list is a valid answer if you find nothing worth reporting.",
    `Report at most ${job.review.maxFindings} finding${job.review.maxFindings === 1 ? "" : "s"}, the most severe first. Past that limit only the most severe are kept.`,
  ].join("\n");
  const example = {
    findings: [
      {
        title: "A malformed upload crashes the server",
        summary: "Uploading a file that doesn't parse takes the whole server down instead of rejecting the upload.\n\n`parse()` returns null on bad input, and the upload handler uses the result without checking it:\n\n- POST a truncated JSON file to /upload\n- the handler reads `doc.id` on null and throws\n- the process exits",
        severity: "high",
        confidence: "medium",
        category: job.profile.categories[0] ?? "correctness",
        evidence: [{ path: "src/server.ts", line: 42, quote: "const doc = parse(body); doc.id", note: "no null check" }],
        recommendation: "Check for null and answer with a 400.",
      },
    ],
  };
  return [header(job, "Review"), task, WRITING_FINDINGS, ending("your findings", '{ "findings": [ ... ] }', "finding", findingInputSchema, example)].join("\n\n");
}

export function groupingPrompt(job: ReviewerJob): string {
  const { review } = job;
  const task = [
    "The reviewers have each reviewed the target independently, and some of them may have found the same problem and reported it in their own words. Before the council deliberates, group the findings below that report the same problem, so each problem is weighed once.",
    "Findings report the same problem when they have the same root cause: one change would fix them all. Check the target where the findings alone don't tell you. Don't group findings that are only alike in kind (two different missing checks), or that sit in different places and need different fixes.",
    "List only groups of two or more findings; leave out findings that stand alone. Don't judge whether the findings are right: that is the deliberation's job. An empty list is fine if no two findings report the same problem.",
  ].join("\n");
  const [first, second] = review.findings;
  const example = {
    groups: [{ findingIds: [first?.id ?? "F1", second?.id ?? "F2"], reason: "Both describe the missing null check on parse()'s result in src/server.ts; checking it fixes both." }],
  };
  return [
    header(job, "Grouping duplicates"),
    task,
    `Findings:\n${review.findings.map((finding) => findingText(finding, review)).join("\n\n")}`,
    ending("your groups", '{ "groups": [ ... ] }', "group", duplicateGroupInputSchema, example),
  ].join("\n\n");
}

export function deliberationPrompt(job: DeliberationJob): string {
  if (job.review.research) return claimDeliberationPrompt(job);
  const { review, reviewer, round, rounds } = job;
  const mine = (finding: Finding) => reportersOf(finding).includes(reviewer.id);
  const findingBlocks = review.findings.map((finding) => {
    const positions = finding.positions.map((p) => `${p.reviewerId} ${p.stance} (${p.confidence})`).join(", ");
    return `${findingText(finding, review)}${mine(finding) ? "\n  THIS IS YOUR OWN FINDING" : ""}\n  positions: ${positions || "none yet"}`;
  });
  const task = [
    `This is deliberation round ${round} of ${rounds}. The reviewers have each reviewed the target independently; their findings are below, with where everyone stands and the arguments made so far. Look at the target again where you need to.`,
    "Weigh in only where you have something new to add:",
    bullets([
      "back a finding with your own evidence (stance \"supports\"),",
      "challenge a finding with evidence (stance \"challenges\"),",
      "answer a challenge to your own finding (set replyTo to the argument's id), standing by it or conceding,",
      "concede your own finding if you no longer support it (stance \"challenges\" or \"uncertain\" on your own finding).",
    ]),
    "Don't repeat arguments already made. An empty list is fine if you have nothing to add.",
    "Write each argument so someone who doesn't know the code can follow it: your conclusion first in one plain sentence, then what you checked. Markdown with inline `code`, **bold** and - bullets only, no code blocks; cite places as path:line. Inside the JSON strings, write each line break as \\n.",
  ].join("\n");
  const example = {
    arguments: [
      {
        findingId: review.findings.find((finding) => !mine(finding))?.id ?? "F1",
        stance: "challenges",
        confidence: "medium",
        text: "This can't happen in practice: the caller already rejects an empty body two lines above (src/server.ts:40), so `parse()` never sees bad input.",
        evidence: [{ path: "src/server.ts", line: 40, quote: "if (!body) return reply(400)" }],
        replyTo: review.arguments[0]?.id ?? undefined,
      },
    ],
  };
  return [
    header(job, `Deliberation ${round}/${rounds}`),
    task,
    `Findings:\n${findingBlocks.join("\n\n")}`,
    `Arguments so far:\n${review.arguments.length === 0 ? "none" : review.arguments.map((a) => argumentText(a)).join("\n")}`,
    ending("your arguments", '{ "arguments": [ ... ] }', "argument", argumentInputSchema, example),
  ].join("\n\n");
}

export function proposalPrompt(job: ProposalJob): string {
  const { review } = job;
  const blocks = findingsById(review, job.findingIds).map((finding) => {
    const res = finding.resolution;
    const names = res?.dissenters.map((id) => id).join(", ");
    const minority = review.arguments.filter((a) => a.findingId === finding.id && a.stance === "challenges" && (res?.dissenters ?? []).includes(a.reviewerId));
    return [
      findingText(finding, review),
      `  council: ${res ? `${res.status}. ${res.rationale}` : "not settled"}${names ? ` Dissenters: ${names}.` : ""}`,
      ...(minority.length > 0 ? [`  minority report (standing challenges):\n${minority.map((a) => `    ${argumentText(a, "      ")}`).join("\n")}`] : []),
    ].join("\n");
  });
  const task = [
    `The council has deliberated and settled. These findings are yours and they stand: ${job.findingIds.join(", ")}. For each, draft one fix proposal, without changing any file: what to do, in order, the files it touches, how to tell it worked, and what could go wrong (including anything the dissent warned about). Report exactly one proposal per finding id listed.`,
  ].join("\n");
  const example = {
    proposals: [
      {
        findingId: job.findingIds[0] ?? "F1",
        summary: "Return a 400 when the body doesn't parse.",
        steps: ["Check parse()'s result for null in src/server.ts.", "Answer 400 with the parse error."],
        files: ["src/server.ts", "tests/server.test.ts"],
        verification: "Add a test posting malformed JSON and expect a 400.",
        risks: "Clients that relied on the crash-and-retry behaviour will see errors.",
      },
    ],
  };
  return [header(job, `Proposals ${idsInTitle(job.findingIds)}`), task, `Findings:\n${blocks.join("\n\n")}`, ending("your proposals", '{ "proposals": [ ... ] }', "proposal", proposalInputSchema, example)].join("\n\n");
}

export function verificationPrompt(job: VerificationJob): string {
  const { review } = job;
  const blocks = findingsById(review, job.findingIds).map((finding) => {
    const fix = finding.fix;
    const proposal = finding.proposal;
    return [
      findingText(finding, review),
      proposal ? `  proposed fix: ${proposal.summary}\n    steps: ${proposal.steps.join(" / ")}\n    verification: ${proposal.verification}` : "  no proposed fix",
      `  fix reported: ${fix?.summary ?? "no summary"}${fix && fix.files.length > 0 ? `\n    files: ${fix.files.join(", ")}` : ""}`,
    ].join("\n");
  });
  const task = `This is re-check pass ${job.pass}. An agent has fixed the findings below. Check the current files and decide for each whether the fix resolves the finding: "verified" or "reopened", with evidence. Report exactly one check per finding id listed: ${job.findingIds.join(", ")}.`;
  const example = {
    checks: [
      {
        findingId: job.findingIds[0] ?? "F1",
        outcome: "verified",
        text: "parse()'s result is now checked and the server answers 400; the new test covers it.",
        evidence: [{ path: "src/server.ts", line: 43, quote: "if (!doc) return reply(400)" }],
      },
    ],
  };
  return [header(job, `Re-check${job.pass > 1 ? ` ${job.pass}` : ""} ${idsInTitle(job.findingIds)}`), task, `Fixed findings:\n${blocks.join("\n\n")}`, ending("your checks", '{ "checks": [ ... ] }', "check", fixCheckInputSchema, example)].join("\n\n");
}

const REPLY_LIMIT = 20_000;

/**
 * The prompt for the one follow-up conversation after a reply whose JSON block couldn't be read. It quotes the original
 * task (with its reply shape, schema and example), the previous reply (its end, where the block belongs) and the problem.
 */
export function repairPrompt(original: string, reply: string, problem: string): string {
  const kept = reply.length > REPLY_LIMIT ? `[...earlier part left out...]\n${reply.slice(-REPLY_LIMIT)}` : reply;
  // The original task's title, marked as the retry it is.
  const title = original.split("\n", 1)[0] ?? "";
  return [
    `Retry · ${title}`,
    "You are a reviewer on a Spectra Council review. In an earlier conversation you were given the task below and answered it, but your answer could not be read by the program that collects it.",
    `The task you were given:\n<task>\n${original}\n</task>`,
    `Your previous reply:\n<previous-reply>\n${kept}\n</previous-reply>`,
    `What was wrong: ${problem}`,
    "Reply again, ending with the one ```json block in exactly the shape the task requires (see its shape, JSON Schema and example). Don't redo the work: turn your previous reply into the required block. Only if the previous reply lacks the content the block needs, re-read the files you must. The read-only rule from the task still holds: change no file and run nothing that writes or installs anything.",
  ].join("\n\n");
}

// ---- Research councils (docs/research.md) ----

const researchOf = (review: Review) => review.research!;

/** The common start of every research turn: who the researcher is, the brief, the rules and the user's instructions. */
function researchHeader({ review, reviewer }: ReviewerJob, task: string): string {
  const research = researchOf(review);
  const brief = research.brief.trim() ? `Read the brief at ${research.brief}` : `The brief is this question:\n${research.question.trim()}`;
  const parts = [
    turnTitle(review, task, reviewer.label),
    `You are researcher ${reviewer.id}, one independent seat on a Spectra Council research council. The workspace folder you may read for context: ${review.target}`,
    brief,
  ];
  const instructions = review.instructions.trim();
  if (instructions) parts.push(`The user's instructions:\n${instructions}`);
  if (reviewer.focus?.trim()) parts.push(`Your focus: lean towards ${reviewer.focus.trim()}, but cover the whole brief.`);
  parts.push(
    [
      "Rules:",
      bullets([
        "You are read-only in the workspace: change no file, and run nothing that writes or installs anything.",
        "Use web search and fetch to find and read sources.",
        "Never invent or reconstruct a citation: report only sources you actually opened. If you can't find it, report a gap.",
        'Prefer peer-reviewed sources and read the full text; where you only saw an abstract or a snippet, mark the source `read: "abstract-only"`.',
        "Quote word for word, short.",
        "Keep facts (what a source says) and your own inferences apart: an inference is a claim of its own.",
        "The brief's own rules for sources win over these.",
      ]),
    ].join("\n"),
  );
  return parts.join("\n\n");
}

const sourceText = (claim: Claim, number: boolean) =>
  claim.sources
    .map((source, at) => {
      const head = `${number ? `    source ${at + 1}: ` : "    "}${source.authors}, "${source.title}", ${source.venue}${source.year ? ` ${source.year}` : ""}. ${source.url}${source.doi ? ` (doi ${source.doi})` : ""}`;
      const lines = [head, `      quote${source.locator ? ` (${source.locator})` : ""}: "${source.quote}"`, `      read: ${source.read}`];
      for (const check of source.checks) lines.push(`      checked by ${check.reviewerId}: ${check.outcome}. ${check.note}`);
      return lines.join("\n");
    })
    .join("\n");

const fieldsText = (claim: Claim) => (Object.keys(claim.fields).length > 0 ? `\n  fields: ${Object.entries(claim.fields).map(([key, value]) => `${key}: ${value}`).join("; ")}` : "");

function claimText(claim: Claim, withChecks = true): string {
  const sources = claim.sources.length > 0 ? `\n  sources:\n${sourceText(claim, true)}` : "\n  sources: none";
  const text = withChecks ? sources : sources.replace(/\n      checked by .*/g, "");
  return [`${claim.id} reported by ${claim.reviewerId}: ${claim.title}`, `  ${claim.rq ? `${claim.rq}, ` : ""}${claim.kind}, confidence ${claim.confidence}`, `  claim: ${indented(claim.text, "    ")}`].join("\n") + fieldsText(claim) + text;
}

export function researchPrompt(job: ReviewerJob): string {
  const { review } = job;
  const research = researchOf(review);
  const followUp = research.pass > 0 ? research.followUps.find((each) => each.pass === research.pass) : undefined;
  const known = claimsOf(review).filter((claim) => claim.pass < research.pass);
  const task = [
    "Your task: research the brief on your own and report claims, each one atomic statement with its sources.",
    bullets([
      'kind "fact": a published fact, with at least one source you opened; "inference": your own reasoning from facts, kept apart from them; "gap": what you searched for and did not find (say where and how you looked), with no source.',
      'rq: the brief\'s research question the claim answers ("RQ1"), or "" when the brief numbers none.',
      "fields: the fields the brief asks for on each record, named exactly as the brief names them; leave out the ones that don't apply.",
      `Report at most ${review.maxFindings} claim${review.maxFindings === 1 ? "" : "s"}, the most useful first.`,
      "Inside the JSON strings, write each line break as \\n.",
    ]),
    'Reply with { "webAccess": boolean, "claims": [...] }. Set webAccess to false if you could not search or fetch the web at all (then claims may be empty).',
  ];
  if (followUp) {
    task.unshift(
      `This is a follow-up run (run ${research.pass}). The council has already answered the brief; the user sent it back with this question:\n${followUp.question}`,
      `Research that question. These claims are already known; don't rediscover them, only add what is new or contradict what is wrong:\n${known.length === 0 ? "none" : known.map((claim) => `- ${claim.id} [${claim.status}] ${claim.title}${claim.sources.length > 0 ? ` (${claim.sources.map((source) => source.title).join("; ")})` : ""}`).join("\n")}`,
    );
  }
  const example = {
    webAccess: true,
    claims: [
      {
        rq: "RQ1",
        kind: "fact",
        title: "Queries on metadata dominate the logged workload",
        text: "Most logged queries filter on study metadata, not on pixel data.",
        confidence: "medium",
        fields: {},
        sources: [{ url: "https://doi.org/10.1000/example", doi: "10.1000/example", authors: "A. Author, B. Author", title: "An example paper", venue: "Example Journal", year: 2021, quote: "metadata queries made up 82% of requests", locator: "Sec. 4.1", read: "full-text" }],
      },
    ],
  };
  return [researchHeader(job, research.pass > 0 ? `Research follow-up ${research.pass}` : "Research"), task.join("\n\n"), ending("your claims", '{ "webAccess": true, "claims": [ ... ] }', "claim", claimInputSchema, example)].join("\n\n");
}

export function claimGroupingPrompt(job: ReviewerJob): string {
  const claims = currentClaims(job.review);
  const task = [
    "The researchers have each researched the brief independently, and some may have reported the same claim in their own words. Before the council checks and argues the claims, group those below that state the same thing, so each is weighed once.",
    "Claims are the same when they rest on the same source and make the same point, or report the same gap. Don't group claims that are only alike in topic, or that make different points from one source.",
    "List only groups of two or more claims; leave out claims that stand alone. Don't judge whether the claims are right. An empty list is fine.",
  ].join("\n");
  const [first, second] = claims;
  const example = { groups: [{ claimIds: [first?.id ?? "C1", second?.id ?? "C2"], reason: "Both report the 82% metadata share from the same paper." }] };
  return [
    researchHeader(job, "Grouping duplicate claims"),
    task,
    `Claims:\n${claims.map((claim) => claimText(claim, false)).join("\n\n")}`,
    ending("your groups", '{ "groups": [ ... ] }', "group", claimGroupInputSchema, example),
  ].join("\n\n");
}

export function sourceCheckPrompt(job: SourceCheckJob): string {
  const claims = job.claimIds.flatMap((id) => claimsOf(job.review).filter((claim) => claim.id === id));
  const task = [
    "Your task: check the sources of the claims below, which other researchers reported. Open every source (follow its link or DOI) and decide whether it says what the claim quotes it saying. Report one check per source:",
    bullets([
      "verified: it says what the claim quotes it saying;",
      "quote-not-found: the quoted passage isn't in it;",
      "doesnt-support: the passage is there but doesn't bear the claim out;",
      "unreachable: the link doesn't resolve;",
      "paywalled: you couldn't read it.",
    ]),
    'Number each claim\'s sources from 1, as listed. Say in "note" what you opened and what you saw. Never guess: if you could not open it, say unreachable or paywalled.',
    `Claims to check: ${job.claimIds.join(", ")}.`,
  ].join("\n");
  const example = { checks: [{ claimId: job.claimIds[0] ?? "C1", source: 1, outcome: "verified", note: "Opened the PDF; the quote is on p. 4 and supports the claim." }] };
  return [
    researchHeader(job, `Check sources ${idsInTitle(job.claimIds)}`),
    task,
    claims.map((claim) => claimText(claim, false)).join("\n\n"),
    ending("your checks", '{ "checks": [ ... ] }', "check", sourceCheckInputSchema, example),
  ].join("\n\n");
}

function claimDeliberationPrompt(job: DeliberationJob): string {
  const { review, reviewer, round, rounds } = job;
  const claims = currentClaims(review);
  const mine = (claim: Claim) => claimReportersOf(claim).includes(reviewer.id);
  const ids = new Set(claims.map((claim) => claim.id));
  const blocks = claims.map((claim) => {
    const positions = claim.positions.map((p) => `${p.reviewerId} ${p.stance} (${p.confidence})`).join(", ");
    return `${claimText(claim)}${mine(claim) ? "\n  THIS IS YOUR OWN CLAIM" : ""}\n  positions: ${positions || "none yet"}`;
  });
  const made = review.arguments.filter((a) => ids.has(a.findingId));
  const task = [
    `This is deliberation round ${round} of ${rounds}. The researchers have each researched the brief independently; their claims are below, with the checks of their sources, where everyone stands and the arguments made so far. Open the sources again where you need to.`,
    "Weigh in only where you have something new to add:",
    bullets([
      'back a claim with your own evidence (stance "supports"),',
      'challenge a claim with evidence (stance "challenges"): a source that says otherwise, a misread quote, a point the sources don\'t bear out, an inference that doesn\'t follow,',
      "answer a challenge to your own claim (set replyTo to the argument's id), standing by it or conceding,",
      'concede your own claim if you no longer support it (stance "challenges" or "uncertain" on your own claim).',
    ]),
    'The claim id goes in "findingId". In evidence, "path" may be a source URL, with a quote from it.',
    "Don't repeat arguments already made. An empty list is fine if you have nothing to add.",
    "Write each argument so someone who doesn't know the topic can follow it: your conclusion first in one plain sentence, then what you checked. Markdown with inline `code`, **bold** and - bullets only. Inside the JSON strings, write each line break as \\n.",
  ].join("\n");
  const target = claims.find((claim) => !mine(claim));
  const example = {
    arguments: [
      {
        findingId: target?.id ?? "C1",
        stance: "challenges",
        confidence: "medium",
        text: "The paper reports 82% for one hospital, not for the whole workload.",
        evidence: [{ path: target?.sources[0]?.url ?? "https://doi.org/10.1000/example", quote: "at the university hospital, 82% of requests" }],
        replyTo: made[0]?.id ?? undefined,
      },
    ],
  };
  return [
    researchHeader(job, `Deliberation ${round}/${rounds}`),
    task,
    `Claims:\n${blocks.join("\n\n")}`,
    `Arguments so far:\n${made.length === 0 ? "none" : made.map((a) => argumentText(a)).join("\n")}`,
    ending("your arguments", '{ "arguments": [ ... ] }', "argument", argumentInputSchema, example),
  ].join("\n\n");
}

/** The whole ledger, as the editor and the draft's checkers read it. */
function ledgerText(review: Review): string {
  return claimsOf(review)
    .map((claim) => {
      const res = claim.resolution;
      const dissent = res?.dissent?.length ? `\n  dissent: ${res.dissent.map((d) => `${d.reviewerId}: ${d.reason || "(no reason given)"}`).join(" | ")}` : "";
      const ruling = claim.ruling ? `\n  user's ruling: ${claim.ruling.decision}${claim.ruling.note ? ` (${claim.ruling.note})` : ""}` : "";
      return `${claimText(claim)}\n  status: ${claim.status}${claim.ruling?.decision === "struck" ? " (STRUCK by the user)" : isClaimStanding(claim) ? " (stands)" : ""}${res ? `\n  council: ${res.rationale}` : ""}${dissent}${ruling}`;
    })
    .join("\n\n");
}

export function draftPrompt(job: DraftJob): string {
  const { review } = job;
  const task = [
    "Your task: write the council's one answer to the brief, from the claims in the ledger below. Write it in the deliverable format the brief asks for (its sections, tables and length); where the brief is a plain question, write a clear structured answer.",
    "Rules:",
    bullets([
      "Every statement cites the claim ids it rests on, as [C3] or [C3, C7]. A statement you can't cite doesn't belong in the answer.",
      "Use only claims that stand: status agreed, confirmed or disputed, and not struck. Never state a withdrawn or struck claim.",
      "A disputed claim goes in only with its dissent: say who disagrees and why (see its dissent line).",
      'A claim with status "unverified" (no source passed the check) may appear only in a final section headed "Leads", worded as something to follow up, not as a finding.',
      ...(review.rounds === 0 ? ["The council did not deliberate: every claim has status 'reported'. You may use them, but say once near the top that the claims were not deliberated or source-checked."] : []),
      "Gaps and inferences are claims too: cite them, and keep what is known apart from what is inferred or missing.",
      "Don't reproduce the ledger: the plugin appends it to your answer. Don't write any file.",
      'Reply with { "answer": "<the answer in Markdown>" }, writing each line break inside the JSON string as \\n and escaping quotes.',
    ]),
  ];
  if (job.revision > 0 && job.previous) {
    task.push(`This is revision ${job.revision}. Your previous draft:\n<draft>\n${job.previous.markdown}\n</draft>`);
    if (job.objections.length > 0) task.push(`The council's objections to it; fix each that is right, and leave the text alone where it is not:\n${job.objections.map((o) => `- ${o.id} by ${o.reviewerId}${o.claimId ? ` on ${o.claimId}` : ""}: "${o.excerpt}" -> ${o.problem}`).join("\n")}`);
    if (job.problems.length > 0) task.push(`Problems the plugin found, which you must fix:\n${bullets(job.problems)}`);
    if (review.research?.revisionDue) task.push("The user has kept or struck claims since the last draft (see the ledger): revise the answer to match.");
  }
  return [
    researchHeader(job, job.revision > 0 ? `Revise the answer ${job.revision}` : "Write the answer"),
    task.join("\n"),
    `The ledger (all claims):\n${ledgerText(review)}`,
    `Reply with one \`\`\`json block, in this shape: { "answer": "..." }. Nothing after the block. You may write one short sentence of plain prose before it.\n\nExample:\n\`\`\`json\n${JSON.stringify({ answer: "## Findings\n\nMost queries filter on metadata [C1, C4]. One reviewer disputes the 82% share [C2]; they note it covers one hospital.\n\n## Leads\n\nA registry study may report the same [C9]." }, null, 2)}\n\`\`\``,
  ].join("\n\n");
}

export function draftCheckPrompt(job: DraftCheckJob): string {
  const { review, draft } = job;
  const task = [
    "Your task: check the editor's draft answer below against the ledger of claims, and report only concrete misstatements. Each is a sentence of the draft that:",
    bullets([
      "overstates a claim (says more, or more firmly, than the claim and its sources do),",
      "misattributes it (to the wrong source, or the wrong seat),",
      "drops a dissent (states a disputed claim without who disagrees and why),",
      "states a struck, unverified or withdrawn claim as a finding,",
      "cites the wrong claim for what it says.",
    ]),
    "Quote the sentence word for word as the excerpt and say what is wrong. Don't report style, wording or what you would add. An empty list is fine and is the usual answer to a good draft.",
  ].join("\n");
  const example = { objections: [{ claimId: "C2", excerpt: "Most queries filter on metadata [C2].", problem: "C2 is disputed and the draft doesn't say who disputes it or why." }] };
  return [
    researchHeader(job, `Check the draft ${draft.revision > 0 ? `(revision ${draft.revision})` : ""}`.trim()),
    task,
    `The ledger (all claims):\n${ledgerText(review)}`,
    `The draft:\n<draft>\n${draft.markdown}\n</draft>`,
    ending("your objections", '{ "objections": [ ... ] }', "objection", draftObjectionInputSchema, example),
  ].join("\n\n");
}
