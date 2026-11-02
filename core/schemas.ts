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

/** How many seats a council has: the workspace shows one panel each. */
export const SEATS = 4;

export const profileIdSchema = z.enum(PROFILE_IDS);
export const depthSchema = z.enum(DEPTHS);
export const severitySchema = z.enum(SEVERITIES);
export const confidenceSchema = z.enum(CONFIDENCES);

export type ProfileId = z.infer<typeof profileIdSchema>;
export type Depth = z.infer<typeof depthSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Confidence = z.infer<typeof confidenceSchema>;

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

/** One seat at the council: the agent in it, or empty. */
export const seatSchema = z.object({
  agent: z.string().min(1).describe("An agent id from the registry."),
  enabled: z.boolean(),
});

export type Seat = z.infer<typeof seatSchema>;

export const setupSchema = z.object({
  target: z.string().min(1).describe("The absolute path of the repository, folder or document to review."),
  profile: profileIdSchema.default("general"),
  depth: depthSchema.default("standard"),
  seats: z.array(seatSchema).length(SEATS),
  instructions: z.string().default(""),
});

export type Setup = z.infer<typeof setupSchema>;

/** The setup fields the view may change before the review starts. */
export const setupPatchSchema = z
  .object({
    target: z.string().min(1),
    profile: profileIdSchema,
    depth: depthSchema,
    seats: z.array(seatSchema).length(SEATS),
    instructions: z.string(),
  })
  .partial();

export type SetupPatch = z.infer<typeof setupPatchSchema>;

/** What the user does in the view. */
export const viewActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("configure"), patch: setupPatchSchema }),
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("stop") }),
]);

export type ViewAction = z.infer<typeof viewActionSchema>;

/** A Zod error in one line per problem, for whoever sent the bad input. */
export const problemsOf = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`).join("; ");
