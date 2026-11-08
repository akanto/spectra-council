/**
 * The shapes that come in from outside the engine (a review's setup, a finding a reviewer reports, an action from the
 * view), as Zod schemas: they validate at the boundary, and `z.toJSONSchema` gives a host the JSON Schema of a tool's
 * input. The engine's own state is typed in model.ts.
 */
import { z } from "zod";

export const PROFILE_IDS = ["general", "code", "architecture", "security", "scientific"] as const;
export const DEPTHS = ["quick", "standard", "deep"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const STANCES = ["supports", "challenges", "uncertain"] as const;
export const DECISIONS = ["accepted", "dismissed", "deferred"] as const;

/** The most seats a council can have; it starts with two, and the user adds and removes seats. The workspace shows one panel each. */
export const MAX_SEATS = 8;

export const profileIdSchema = z.enum(PROFILE_IDS);
export const depthSchema = z.enum(DEPTHS);
export const severitySchema = z.enum(SEVERITIES);
export const confidenceSchema = z.enum(CONFIDENCES);
export const stanceSchema = z.enum(STANCES);
export const decisionSchema = z.enum(DECISIONS);
/** Deliberation rounds, 1 to 6 (core/depth.ts ROUNDS_RANGE). */
export const roundsSchema = z.number().int().min(1).max(6);
/** The most findings one reviewer reports, 1 to 20 (core/depth.ts MAX_FINDINGS_RANGE). */
export const maxFindingsSchema = z.number().int().min(1).max(20);

export type ProfileId = z.infer<typeof profileIdSchema>;
export type Depth = z.infer<typeof depthSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Stance = z.infer<typeof stanceSchema>;
export type Decision = z.infer<typeof decisionSchema>;

export const evidenceSchema = z.object({
  path: z.string().min(1).describe("The file, relative to the review's target folder."),
  line: z.number().int().positive().optional().describe("The first line the evidence is on."),
  endLine: z.number().int().positive().optional().describe("The last line, for a range."),
  quote: z.string().optional().describe("The text quoted from the file, short."),
  note: z.string().optional().describe("What this piece of evidence shows."),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/** A finding as a reviewer reports it; the engine gives it its id, reviewer and status. */
export const findingInputSchema = z.object({
  title: z.string().min(1).max(160).describe("The problem in a few words."),
  summary: z.string().min(1).describe("What is wrong and why it matters, in a few sentences."),
  severity: severitySchema,
  confidence: confidenceSchema.describe("How sure the reviewer is that the problem is real."),
  category: z.string().min(1).describe('The kind of problem, e.g. "correctness", "methodology", "injection".'),
  evidence: z.array(evidenceSchema).min(1).describe("Where in the target it shows; at least one place."),
  recommendation: z.string().optional().describe("What would fix it."),
});

export type FindingInput = z.infer<typeof findingInputSchema>;

/**
 * What a reviewer argues about a finding in a deliberation round: its stance, why, and the evidence. A reporter that
 * no longer supports its own finding concedes it.
 */
export const argumentInputSchema = z.object({
  findingId: z.string().min(1).describe('The finding argued about, e.g. "F3".'),
  stance: stanceSchema.describe("Whether the reviewer backs the finding, challenges it, or can't tell yet."),
  confidence: confidenceSchema.describe("How sure the reviewer is of its stance."),
  text: z.string().min(1).describe("The argument in a few sentences: what the reviewer checked and what it showed."),
  evidence: z.array(evidenceSchema).default([]).describe("Where in the target the argument rests; a challenge should point at something."),
  replyTo: z.string().min(1).optional().describe('The argument this one answers, e.g. "A4".'),
});

export type ArgumentInput = z.infer<typeof argumentInputSchema>;

/** The fix a reviewer proposes for a finding that stands, in the synthesis. */
export const proposalInputSchema = z.object({
  findingId: z.string().min(1).describe('The finding the fix is for, e.g. "F3".'),
  summary: z.string().min(1).describe("The fix in a sentence."),
  steps: z.array(z.string().min(1)).min(1).describe("What to do, in order."),
  files: z.array(z.string().min(1)).default([]).describe("The files the fix touches, relative to the target."),
  verification: z.string().min(1).describe("How to tell the fix worked: a test to add, a check to run."),
  risks: z.string().min(1).optional().describe("What could go wrong, including anything the dissent warned about."),
});

export type ProposalInput = z.infer<typeof proposalInputSchema>;

/** A reviewer's re-check of a fix, in a verification round. */
export const fixCheckInputSchema = z.object({
  findingId: z.string().min(1).describe('The finding whose fix was checked, e.g. "F3".'),
  outcome: z.enum(["verified", "reopened"]).describe("Whether the fix resolves the finding."),
  text: z.string().min(1).describe("What the reviewer checked and what it showed, in a few sentences."),
  evidence: z.array(evidenceSchema).default([]).describe("Where in the target the check rests."),
});

export type FixCheckInput = z.infer<typeof fixCheckInputSchema>;

/**
 * Findings that report the same problem, as an agent grouped them by meaning after the independent review: they merge
 * into one.
 */
export const duplicateGroupInputSchema = z.object({
  findingIds: z.array(z.string().min(1)).min(2).describe('The findings that report the same problem, e.g. ["F2", "F7"].'),
  reason: z.string().min(1).describe("Why they are the same problem, in a sentence: the shared root cause, or the one change that fixes them all."),
});

export type DuplicateGroupInput = z.infer<typeof duplicateGroupInputSchema>;

/** One seat at the council: the agent in it. `enabled` is false only in reviews from before seats could be removed. */
export const seatSchema = z.object({
  agent: z.string().min(1).describe('A mock persona\'s id (mock-claude, …), or "profile:" and a Mirador profile\'s name, e.g. "profile:pi home".'),
  enabled: z.boolean(),
});

export type Seat = z.infer<typeof seatSchema>;

export const setupSchema = z.object({
  target: z.string().min(1).describe("The absolute path of the repository, folder or document to review."),
  profile: profileIdSchema.default("general"),
  depth: depthSchema.default("standard"),
  /** Overrides the depth preset's rounds. */
  deliberationRounds: roundsSchema.optional(),
  /** Overrides the depth preset's most findings per reviewer. */
  maxFindings: maxFindingsSchema.optional(),
  seats: z.array(seatSchema).max(MAX_SEATS),
  instructions: z.string().default(""),
});

export type Setup = z.infer<typeof setupSchema>;

/** The setup fields the view may change before the review starts. */
export const setupPatchSchema = z
  .object({
    target: z.string().min(1),
    profile: profileIdSchema,
    /** A preset: sets both knobs to its values (a knob in the same patch wins). */
    depth: depthSchema,
    deliberationRounds: roundsSchema,
    maxFindings: maxFindingsSchema,
    seats: z.array(seatSchema).min(1).max(MAX_SEATS),
    instructions: z.string(),
  })
  .partial();

export type SetupPatch = z.infer<typeof setupPatchSchema>;

/** What the user does in the view. */
export const viewActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("configure"), patch: setupPatchSchema }),
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("stop") }),
  /** The user's ruling on a finding after the verdict; a null decision clears it. */
  z.object({ kind: z.literal("rule"), findingId: z.string().min(1), decision: decisionSchema.nullable(), note: z.string().default("") }),
  /** Write the hand-off document of the accepted findings. */
  z.object({ kind: z.literal("handoff") }),
  /** Run a reviewer that failed in the independent review again, while the review runs. */
  z.object({ kind: z.literal("retry"), reviewerId: z.string().min(1) }),
  /** Take a failed reviewer off the council: its panel and its positions go (and, during the independent review, its findings). */
  z.object({ kind: z.literal("remove"), reviewerId: z.string().min(1) }),
  /** Go on with a review a restart of the host cut short, from the phase it was in. */
  z.object({ kind: z.literal("resume") }),
  /** Ask the conversation's agent to open a new review with this one's setup, for a review that ended. */
  z.object({ kind: z.literal("rerun") }),
  /** Ask the conversation's agent to fix the accepted findings, by the hand-off. */
  z.object({ kind: z.literal("fix") }),
  /** Re-check the fixed findings in a verification round. */
  z.object({ kind: z.literal("verify") }),
  /** Who fixes: resolves to `{ profile }`, the fixer profile this conversation chose, or null for its own agent. */
  z.object({ kind: z.literal("fixer") }),
  /**
   * The Mirador profiles a seat can take: resolves to `{ profiles: ProfileInfo[] }` (core/agents.ts), each with the model
   * its latest conversation ran on where the host can tell.
   */
  z.object({ kind: z.literal("profiles") }),
]);

export type ViewAction = z.infer<typeof viewActionSchema>;

/**
 * What a real reviewer ends each turn's final message with, as a ```json block: the items of its turn, each checked
 * later on its own against the schema above (a malformed one shows as an error, the rest still count).
 */
export const reviewReplySchema = z.object({ findings: z.array(z.unknown()) });
export const deliberationReplySchema = z.object({ arguments: z.array(z.unknown()) });
export const proposalReplySchema = z.object({ proposals: z.array(z.unknown()) });
export const verificationReplySchema = z.object({ checks: z.array(z.unknown()) });
export const groupingReplySchema = z.object({ groups: z.array(z.unknown()) });

/** A Zod error in one line per problem, for whoever sent the bad input. */
export const problemsOf = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`).join("; ");
