/**
 * The prompts a real agent gets, one per turn of a review: its independent review, the grouping of duplicate findings,
 * a deliberation round, the fix proposals and the re-check of fixes. Each stands on its own (the agent sees nothing else) and ends by asking for the
 * reply as a ```json block, which agent-runner.ts reads. Pure: the same job gives the same prompt.
 */
import { z } from "zod";
import type { DeliberationJob, ProposalJob, ReviewerJob, VerificationJob } from "./engine.ts";
import { reportersOf, type Argument, type Finding, type Review } from "./model.ts";
import {
  argumentInputSchema,
  duplicateGroupInputSchema,
  type Evidence,
  findingInputSchema,
  fixCheckInputSchema,
  proposalInputSchema,
} from "./schemas.ts";

const schemaOf = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema), null, 2);

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

/** The common start of every turn: who the reviewer is, the rules, the profile's brief and the user's instructions. */
function header({ review, reviewer, profile }: ReviewerJob): string {
  const parts = [
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
    `End your final message with one \`\`\`json block holding ${what}, in this shape: ${shape}. Nothing after the block. You may write short prose before it.`,
    `Each ${itemName} must fit this JSON Schema:\n\`\`\`\n${schemaOf(schema)}\n\`\`\``,
    `Example:\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``,
  ].join("\n\n");
}

const evidenceLine = (e: Evidence) => `${e.path}${e.line ? `:${e.line}${e.endLine ? `-${e.endLine}` : ""}` : ""}${e.quote ? ` "${e.quote}"` : ""}${e.note ? ` (${e.note})` : ""}`;
const evidenceText = (evidence: Evidence[]) => (evidence.length === 0 ? "none" : evidence.map(evidenceLine).join("; "));

function findingText(finding: Finding, review: Review): string {
  return [
    `${finding.id} reported by ${finding.reviewerId}: ${finding.title}`,
    `  severity ${finding.severity}, confidence ${finding.confidence}, category ${finding.category}`,
    `  summary: ${finding.summary}`,
    `  evidence: ${evidenceText(finding.evidence)}`,
    ...(finding.recommendation ? [`  recommendation: ${finding.recommendation}`] : []),
  ].join("\n");
}

const argumentText = (a: Argument) =>
  `${a.id} [round ${a.round}] ${a.reviewerId} on ${a.findingId}, ${a.stance} (${a.confidence})${a.replyTo ? `, replying to ${a.replyTo}` : ""}: ${a.text}${a.evidence.length > 0 ? ` Evidence: ${evidenceText(a.evidence)}` : ""}`;

const findingsById = (review: Review, ids: string[]) => ids.flatMap((id) => review.findings.filter((finding) => finding.id === id));

export function reviewPrompt(job: ReviewerJob): string {
  const task = [
    "Your task: review the target on your own and report the problems that matter, each with evidence: a path (and a line where you can) and a short quote. Don't pad the list; an empty list is a valid answer if you find nothing worth reporting.",
    `Report at most ${job.review.maxFindings} finding${job.review.maxFindings === 1 ? "" : "s"}, the most severe first. Past that limit only the most severe are kept.`,
  ].join("\n");
  const example = {
    findings: [
      {
        title: "Unchecked result of the parser",
        summary: "parse() can return null on bad input, and the caller dereferences it, so a malformed file crashes the server.",
        severity: "high",
        confidence: "medium",
        category: job.profile.categories[0] ?? "correctness",
        evidence: [{ path: "src/server.ts", line: 42, quote: "const doc = parse(body); doc.id", note: "no null check" }],
        recommendation: "Check for null and answer with a 400.",
      },
    ],
  };
  return [header(job), task, ending("your findings", '{ "findings": [ ... ] }', "finding", findingInputSchema, example)].join("\n\n");
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
    header(job),
    task,
    `Findings:\n${review.findings.map((finding) => findingText(finding, review)).join("\n\n")}`,
    ending("your groups", '{ "groups": [ ... ] }', "group", duplicateGroupInputSchema, example),
  ].join("\n\n");
}

export function deliberationPrompt(job: DeliberationJob): string {
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
  ].join("\n");
  const example = {
    arguments: [
      {
        findingId: review.findings.find((finding) => !mine(finding))?.id ?? "F1",
        stance: "challenges",
        confidence: "medium",
        text: "The caller already validates the input two lines above, so the null case cannot happen.",
        evidence: [{ path: "src/server.ts", line: 40, quote: "if (!body) return reply(400)" }],
        replyTo: review.arguments[0]?.id ?? undefined,
      },
    ],
  };
  return [
    header(job),
    task,
    `Findings:\n${findingBlocks.join("\n\n")}`,
    `Arguments so far:\n${review.arguments.length === 0 ? "none" : review.arguments.map(argumentText).join("\n")}`,
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
      ...(minority.length > 0 ? [`  minority report (standing challenges):\n${minority.map((a) => `    ${argumentText(a)}`).join("\n")}`] : []),
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
  return [header(job), task, `Findings:\n${blocks.join("\n\n")}`, ending("your proposals", '{ "proposals": [ ... ] }', "proposal", proposalInputSchema, example)].join("\n\n");
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
  return [header(job), task, `Fixed findings:\n${blocks.join("\n\n")}`, ending("your checks", '{ "checks": [ ... ] }', "check", fixCheckInputSchema, example)].join("\n\n");
}

const REPLY_LIMIT = 20_000;

/**
 * The prompt for the one follow-up conversation after a reply whose JSON block couldn't be read. It quotes the original
 * task (with its reply shape, schema and example), the previous reply (its end, where the block belongs) and the problem.
 */
export function repairPrompt(original: string, reply: string, problem: string): string {
  const kept = reply.length > REPLY_LIMIT ? `[...earlier part left out...]\n${reply.slice(-REPLY_LIMIT)}` : reply;
  return [
    "You are a reviewer on a Spectra Council review. In an earlier conversation you were given the task below and answered it, but your answer could not be read by the program that collects it.",
    `The task you were given:\n<task>\n${original}\n</task>`,
    `Your previous reply:\n<previous-reply>\n${kept}\n</previous-reply>`,
    `What was wrong: ${problem}`,
    "Reply again, ending with the one ```json block in exactly the shape the task requires (see its shape, JSON Schema and example). Don't redo the work: turn your previous reply into the required block. Only if the previous reply lacks the content the block needs, re-read the files you must. The read-only rule from the task still holds: change no file and run nothing that writes or installs anything.",
  ].join("\n\n");
}
