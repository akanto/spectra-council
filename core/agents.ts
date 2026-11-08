/**
 * The agents that can take a seat at the council: deterministic mock personas, and the user's Mirador profiles (Claude,
 * pi, opencode, …), whose agent id is "profile:" and the profile's name. A seat runs on its profile's defaults: the
 * agent's default model and the profile's effort (docs/mirador-api.md has what Mirador would need for more). The
 * review names a profile seat by its model ("Opus 5.5"), once the host could tell which.
 */
import type { ModelInfo, Reviewer, RunnerKind } from "./model.ts";
import type { Seat } from "./schemas.ts";

export interface AgentInfo {
  id: string;
  label: string;
  kind: "mock" | "mirador-profile";
  /** One line for the setup. */
  blurb: string;
}

/**
 * Mock personas, named after the agents they stand in for so the workspace looks as it will, and marked mock wherever
 * they show. Each reads in its own order and favours its own kinds of finding.
 */
export const MOCK_AGENTS: AgentInfo[] = [
  { id: "mock-claude", label: "Claude", kind: "mock", blurb: "Mock reviewer: methodical, reads tests first." },
  { id: "mock-codex", label: "Codex", kind: "mock", blurb: "Mock reviewer: fast, code-path focused." },
  { id: "mock-gemini", label: "Gemini", kind: "mock", blurb: "Mock reviewer: broad, checks docs and configuration." },
  { id: "mock-qwen", label: "Qwen", kind: "mock", blurb: "Mock reviewer: thorough and slow." },
  { id: "mock-glm", label: "GLM", kind: "mock", blurb: "Mock reviewer: checks the contracts between modules." },
];

export const agentById = (id: string, agents: AgentInfo[] = MOCK_AGENTS) => agents.find((agent) => agent.id === id);

export const PROFILE_PREFIX = "profile:";

/** Whether an agent id names a Mirador profile rather than a mock persona. */
export const isProfileAgent = (id: string) => id.startsWith(PROFILE_PREFIX) && id.length > PROFILE_PREFIX.length;

/** The agent id of the Mirador profile of that name. */
export const profileAgent = (name: string) => `${PROFILE_PREFIX}${name.trim()}`;

/** The profile's name of a profile agent id. */
export const profileName = (id: string) => id.slice(PROFILE_PREFIX.length);

/** Who runs a council with these seats: mocks only, Mirador profiles only, or both. */
export function runnerKindOf(seats: { agent: string; enabled: boolean }[]): RunnerKind {
  const seated = seats.filter((seat) => seat.enabled);
  const profiles = seated.filter((seat) => isProfileAgent(seat.agent)).length;
  return profiles === 0 ? "mock" : profiles === seated.length ? "mirador" : "mixed";
}

/** An agent's name to show: a mock persona's, or a Mirador profile's ("profile:Home" shows as "Home"). */
export function agentLabel(id: string): string {
  const known = agentById(id);
  if (known) return known.label;
  return isProfileAgent(id) ? profileName(id) : id;
}

/** Two mock seats, the first two agents: for tests and demos (council_open seats the user's profiles by default). */
export function defaultSeats(agents: AgentInfo[] = MOCK_AGENTS): Seat[] {
  return Array.from({ length: 2 }, (_, index) => ({ agent: agents[index % agents.length]!.id, enabled: true }));
}

/**
 * A Mirador profile a seat can take, as the host knows it: its name, which agent runs it ("claude", "pi", …; "" when
 * unknown), and the model its latest conversation ran on (null when unknown), which a new conversation on it most
 * likely runs on too.
 */
export interface ProfileInfo {
  name: string;
  harness: string;
  model: ModelInfo | null;
}

/** A model with its effort, in a few words: "Opus 5.5 · high", or just "Opus 5.5". */
export const modelLabel = (model: ModelInfo) => (model.effort ? `${model.name} · ${model.effort}` : model.name);

/**
 * The reviewers with their labels: a profile seat's model name when known, else its profile's or mock's name. Two
 * seats with the same name are told apart by their profile ("Opus 5.5 (Home)") when that differs, else by number
 * ("Claude 2").
 */
export function withLabels(reviewers: Reviewer[]): Reviewer[] {
  const base = reviewers.map((reviewer) => (isProfileAgent(reviewer.agent) && reviewer.model ? reviewer.model.name : agentLabel(reviewer.agent)));
  const named = base.map((label, index) => {
    const agent = reviewers[index]!.agent;
    const twins = base.filter((other, at) => other === label && reviewers[at]!.agent !== agent);
    return twins.length > 0 && isProfileAgent(agent) && profileName(agent) !== label ? `${label} (${profileName(agent)})` : label;
  });
  const labels = named.map((label, index) => {
    const same = named.filter((other) => other === label).length;
    if (same === 1) return label;
    return `${label} ${named.slice(0, index + 1).filter((other) => other === label).length}`;
  });
  return reviewers.map((reviewer, index) => (reviewer.label === labels[index] ? reviewer : { ...reviewer, label: labels[index]! }));
}

/**
 * What to show under a reviewer's label: a profile seat's effort and profile ("high effort · Home profile"), or
 * "mock" for a mock persona.
 */
export function seatDetail(reviewer: Pick<Reviewer, "agent" | "model">): string {
  if (!isProfileAgent(reviewer.agent)) return "mock";
  return [reviewer.model?.effort ? `${reviewer.model.effort} effort` : null, `${profileName(reviewer.agent)} profile`].filter(Boolean).join(" · ");
}
