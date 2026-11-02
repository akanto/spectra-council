/**
 * The agents that can take a seat at the council: deterministic mock personas, and the user's Mirador profiles (Claude,
 * pi, opencode, …), whose agent id is "profile:" and the profile's name. A seat runs on its profile's defaults: the
 * agent's default model and the profile's effort (docs/mirador-api.md has what Mirador would need for more).
 */
import type { RunnerKind } from "./model.ts";
import { SEATS, type Seat } from "./schemas.ts";

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

/** The seats a new review starts with: all four agents seated, the first two taking part, as milestone 1 asks. */
export function defaultSeats(agents: AgentInfo[] = MOCK_AGENTS): Seat[] {
  return Array.from({ length: SEATS }, (_, index) => ({ agent: agents[index % agents.length]!.id, enabled: index < 2 }));
}
