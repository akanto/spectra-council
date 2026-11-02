/**
 * The agents that can take a seat at the council. Milestone 1 has deterministic mock personas only; milestone 2 adds the
 * user's Mirador profiles (Claude, pi, opencode, …) as agents of kind "mirador-profile".
 */
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

/** An agent's name to show: a mock persona's, or a Mirador profile's ("profile:Home" shows as "Home"). */
export function agentLabel(id: string): string {
  const known = agentById(id);
  if (known) return known.label;
  return id.startsWith("profile:") ? id.slice("profile:".length) : id;
}

/** The seats a new review starts with: all four agents seated, the first two taking part, as milestone 1 asks. */
export function defaultSeats(agents: AgentInfo[] = MOCK_AGENTS): Seat[] {
  return Array.from({ length: SEATS }, (_, index) => ({ agent: agents[index % agents.length]!.id, enabled: index < 2 }));
}
