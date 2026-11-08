/**
 * Review profiles: what a council looks for. The brief goes to each reviewer (milestone 2), the focus areas show in the
 * setup, and the categories are the ones its findings are expected to use. Kept as code rather than YAML so the engine
 * carries no parser and the types check them.
 */
import type { ProfileId } from "./schemas.ts";

export interface ReviewProfile {
  id: ProfileId;
  title: string;
  /** One line for the setup. */
  blurb: string;
  focus: string[];
  categories: string[];
  /** What each reviewer is told to do, before the target and the user's instructions. */
  brief: string;
}

export const PROFILES: Record<ProfileId, ReviewProfile> = {
  general: {
    id: "general",
    title: "General",
    blurb: "Anything that looks wrong, unclear or risky.",
    focus: ["Correctness", "Clarity", "Risks", "Missing pieces"],
    categories: ["correctness", "clarity", "risk", "completeness"],
    brief: "Review the target as a careful, independent expert. Report problems that matter, each with evidence.",
  },
  code: {
    id: "code",
    title: "Code",
    blurb: "Bugs, error handling, tests and maintainability.",
    focus: ["Correctness bugs", "Error handling", "Concurrency", "Test coverage", "Maintainability"],
    categories: ["correctness", "error-handling", "concurrency", "testing", "maintainability", "performance"],
    brief:
      "Review the code for defects a careful senior engineer would block a merge on: wrong results, unhandled failures, races, missing tests for risky paths. Prefer few real findings over many speculative ones.",
  },
  architecture: {
    id: "architecture",
    title: "Architecture",
    blurb: "Boundaries, coupling, scalability and failure modes.",
    focus: ["Module boundaries", "Coupling", "Scalability assumptions", "Failure scenarios", "Operability"],
    categories: ["boundaries", "coupling", "scalability", "resilience", "operability", "data-model"],
    brief:
      "Review the system's architecture: where responsibilities sit, what depends on what, what breaks under load or partial failure, and which assumptions are unsupported.",
  },
  security: {
    id: "security",
    title: "Security",
    blurb: "Injection, authorization, secrets and unsafe defaults.",
    focus: ["Input handling", "Authentication and authorization", "Secrets", "Dependencies", "Unsafe defaults"],
    categories: ["injection", "authz", "secrets", "crypto", "dependencies", "configuration"],
    brief:
      "Review the target for exploitable weaknesses. For each finding, name the attacker, the path they take and what they gain; mark anything you could not confirm as low confidence.",
  },
  scientific: {
    id: "scientific",
    title: "Scientific",
    blurb: "Methodology, statistics, reproducibility and claims.",
    focus: ["Methodology", "Data leakage", "Statistics", "Reproducibility", "Claims vs. evidence"],
    categories: ["methodology", "data-leakage", "statistics", "reproducibility", "claims", "related-work"],
    brief:
      "Review the work as a demanding peer reviewer: is the method sound, is the evaluation free of leakage and bias, do the numbers support the claims, and could someone reproduce it?",
  },
};


