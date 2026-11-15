/**
 * A research council's pure rules (docs/research.md): which claims the current run weighs, who checks whose sources,
 * how a claim settles, which claims a draft may cite, and the verdict line. The engine runs the turns and dispatches
 * what these decide; the answer's Markdown is rendered in answer.ts.
 */
import { shortName } from "./agents.ts";
import { settle, type Settlement } from "./deliberation.ts";
import { claimReportersOf, isClaimStanding, seatedReviewers, type Claim, type ClaimStatus, type Review, type Reviewer } from "./model.ts";

/** The claims the current run weighs: those it reported. Earlier runs' claims stay settled as they were. */
export const currentClaims = (review: Review): Claim[] => {
  const research = review.research;
  return research ? research.claims.filter((claim) => claim.pass === research.pass) : [];
};

export const claimById = (review: Review, id: string): Claim | undefined => review.research?.claims.find((claim) => claim.id === id);

/** How a claim settles: as a finding does, except that a fact none of whose sources was verified is `unverified`. */
export interface ClaimSettlement extends Omit<Settlement, "status"> {
  status: Exclude<ClaimStatus, "reported">;
}

/**
 * Settles a claim of the current run from the council's stances (`settle`), then holds facts to their sources: a fact
 * that would stand (agreed, confirmed or disputed) but has no source a checker verified is `unverified`, and goes among
 * the answer's leads only. A run without deliberation (`rounds` 0) checked nothing and settles nothing.
 */
export function settleClaim(review: Review, claim: Claim): ClaimSettlement | null {
  if (review.rounds === 0) return null;
  const settlement = settle(review, claim);
  if (!settlement || settlement.status === "withdrawn" || claim.kind !== "fact") return settlement;
  const verified = claim.sources.some((source) => source.checks.some((check) => check.outcome === "verified"));
  if (verified) return settlement;
  const checked = claim.sources.flatMap((source) => source.checks);
  const why = checked.length === 0 ? "nobody could check its sources" : `no check verified its sources (${[...new Set(checked.map((check) => check.outcome))].join(", ")})`;
  return { ...settlement, status: "unverified", rationale: `${settlement.rationale.replace(/\.$/, "")}; ${why}.`, dissenters: [], dissent: undefined };
}

/**
 * Who checks the sources of each claim of the current run, by seat: one seat per claim with sources, never one of its
 * reporters while another sits, preferring a seat on another model than its reporter's, spread so each checks about as
 * many as the next. With only its reporters sitting, one who isn't its first reporter checks it; with none, nobody does.
 */
export function assignSourceChecks(review: Review): Map<string, string[]> {
  const sitting = seatedReviewers(review).filter((reviewer) => reviewer.status === "deliberating");
  const load = new Map<string, string[]>(sitting.map((reviewer) => [reviewer.id, []]));
  const modelOf = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.model?.name ?? review.reviewers.find((reviewer) => reviewer.id === id)?.agent;
  for (const claim of currentClaims(review)) {
    if (claim.sources.length === 0) continue;
    const reporters = claimReportersOf(claim);
    let pool: Reviewer[] = sitting.filter((reviewer) => !reporters.includes(reviewer.id));
    if (pool.length === 0) pool = sitting.filter((reviewer) => reviewer.id !== claim.reviewerId);
    if (pool.length === 0) continue;
    const otherModel = pool.filter((reviewer) => modelOf(reviewer.id) !== modelOf(claim.reviewerId));
    const candidates = otherModel.length > 0 ? otherModel : pool;
    // Among the least loaded, the seat next after the reporter in seat order, so the checks go round.
    const seat = (id: string) => review.reviewers.findIndex((reviewer) => reviewer.id === id);
    const after = (id: string) => (seat(id) - seat(claim.reviewerId) + review.reviewers.length) % review.reviewers.length;
    const checker = [...candidates].sort((a, b) => load.get(a.id)!.length - load.get(b.id)!.length || after(a.id) - after(b.id))[0]!;
    load.get(checker.id)!.push(claim.id);
  }
  for (const [id, claims] of load) if (claims.length === 0) load.delete(id);
  return load;
}

/** The seat that writes the answer: the chosen editor while it sits, else the first seat still at the council. */
export function editorOf(review: Review): Reviewer | undefined {
  const sitting = seatedReviewers(review).filter((reviewer) => reviewer.status === "deliberating");
  return sitting.find((reviewer) => reviewer.id === review.research?.editor) ?? sitting[0];
}

const CITATION = /\[(C\d+(?:\s*[,;]\s*C\d+)*)\]/g;

/** The claim ids a draft cites, as `[C12]` or `[C3, C7]`, in order of first citation. */
export function citedClaimIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(CITATION)) for (const id of match[1]!.split(/\s*[,;]\s*/)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * What is wrong with a draft against the ledger: it cites a claim that doesn't exist, or one that doesn't stand
 * (withdrawn, struck or still unsettled), or, with claims standing, cites none. An unverified claim may be cited, among
 * the leads. Empty when the draft is fine.
 */
export function draftProblems(review: Review, markdown: string): string[] {
  const claims = review.research?.claims ?? [];
  const cited = citedClaimIds(markdown);
  const problems: string[] = [];
  for (const id of cited) {
    const claim = claims.find((each) => each.id === id);
    if (!claim) problems.push(`It cites ${id}, which no claim has.`);
    else if (claim.ruling?.decision === "struck") problems.push(`It cites ${id}, which the user struck.`);
    else if (claim.status === "withdrawn") problems.push(`It cites ${id}, which its reporter withdrew.`);
  }
  if (cited.length === 0 && claims.some(isClaimStanding)) problems.push("It cites no claim: every statement must cite the claims it rests on, as [C3].");
  return problems;
}

/** The answer file's default: `<brief name>-answer.md` beside the brief. */
export function defaultAnswerFile(brief: string): string {
  const slash = brief.lastIndexOf("/");
  const folder = slash >= 0 ? brief.slice(0, slash) : ".";
  const name = (slash >= 0 ? brief.slice(slash + 1) : brief).replace(/\.(md|markdown|txt)$/i, "");
  return `${folder}/${name || "research"}-answer.md`;
}

/** Where a research council's answer goes. */
export const answerPathOf = (review: Review): string | null => {
  const research = review.research;
  if (!research) return null;
  if (research.answerFile.trim()) return research.answerFile.trim();
  return research.brief ? defaultAnswerFile(research.brief) : null;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The research council's verdict line, from its claims and answer. */
export function researchSummary(review: Review): string {
  const claims = review.research?.claims ?? [];
  const failed = review.reviewers.filter((reviewer) => reviewer.enabled && reviewer.status === "failed");
  const dropped = failed.length > 0 ? ` ${failed.map(shortName).join(", ")} failed and couldn't continue.` : "";
  if (claims.length === 0) return `The council reported no claims.${dropped}`;
  const count = (status: ClaimStatus) => claims.filter((claim) => claim.status === status).length;
  const parts = (["agreed", "confirmed", "disputed", "unverified", "withdrawn", "reported"] as const).filter((status) => count(status) > 0).map((status) => `${count(status)} ${status === "reported" ? "not deliberated" : status}`);
  const struck = claims.filter((claim) => claim.ruling?.decision === "struck").length;
  if (struck > 0) parts.push(`${struck} struck`);
  const answered = (review.research?.drafts.length ?? 0) > 0 ? " The editor wrote the answer from the claims that stand." : " No answer was written.";
  return `${plural(claims.length, "claim")}: ${parts.join(", ")}.${answered}${dropped}`;
}
