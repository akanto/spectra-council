/**
 * The agents that can take a seat at the council: deterministic mock personas, and the user's Mirador profiles (Claude,
 * pi, opencode, …), whose agent id is "profile:" and the profile's name. A profile seat runs on its profile's defaults
 * (the agent's default model and the profile's effort) unless the user chose a model or effort for it (`SeatChoice`).
 * The review names a profile seat by its model ("Opus 5.5"), once the host could tell which.
 */
import type { ModelInfo, Reviewer, RunnerKind, SeatChoice } from "./model.ts";
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

/** A seat for a Mirador profile not named yet ("Add reviewer" once every known profile is seated): it can't start. */
export const UNNAMED_PROFILE = PROFILE_PREFIX;

/** Whether an agent id names one of the deterministic mock personas. */
export const isMockAgent = (id: string) => agentById(id) !== undefined;

/** Whether an agent id can run: a named Mirador profile or a known mock persona. */
export const isRunnableAgent = (id: string) => isProfileAgent(id) || isMockAgent(id);

/** The agent id of the Mirador profile of that name. */
export const profileAgent = (name: string) => `${PROFILE_PREFIX}${name.trim()}`;

/** The profile's name of a profile agent id. */
export const profileName = (id: string) => id.slice(PROFILE_PREFIX.length);

/** Who runs a council with these seats: mocks only, Mirador profiles only, or both. */
export function runnerKindOf(seats: { agent: string; enabled: boolean }[]): RunnerKind {
  const seated = seats.filter((seat) => seat.enabled);
  const profiles = seated.filter((seat) => isProfileAgent(seat.agent) || seat.agent === UNNAMED_PROFILE).length;
  return profiles === 0 ? "mock" : profiles === seated.length ? "mirador" : "mixed";
}

/** An agent's name to show: a mock persona's, or a Mirador profile's ("profile:Home" shows as "Home"). */
export function agentLabel(id: string): string {
  const known = agentById(id);
  if (known) return known.label;
  if (id === UNNAMED_PROFILE) return "Unnamed profile";
  return isProfileAgent(id) ? profileName(id) : id;
}

/** A profile seat's own model and effort, undefined when it has neither or isn't a profile seat (a mock has no choice). */
export function choiceOf(seat: Pick<Seat, "agent" | "model" | "effort">): SeatChoice | undefined {
  if (!isProfileAgent(seat.agent) && seat.agent !== UNNAMED_PROFILE) return undefined;
  const model = seat.model?.trim();
  const effort = seat.effort?.trim();
  if (!model && !effort) return undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** Whether two choices of model and effort are the same (absent ones count as the profile's own). */
export const sameChoice = (a: SeatChoice | undefined, b: SeatChoice | undefined) => (a?.model ?? "") === (b?.model ?? "") && (a?.effort ?? "") === (b?.effort ?? "");

/** A choice of model and effort in a few words: "opus, high effort", "high effort"; "" for none. */
export const choiceText = (choice: SeatChoice | undefined) => [choice?.model, choice?.effort ? `${choice.effort} effort` : undefined].filter(Boolean).join(", ");

/** The seat a reviewer sits in: its agent and its choice of model and effort, as the setup edits it. */
export function seatOf(reviewer: Pick<Reviewer, "agent" | "enabled" | "choice">): Seat {
  return { agent: reviewer.agent, enabled: reviewer.enabled, ...reviewer.choice };
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
  /** The models its agent offered in its latest conversation, for a seat to choose from; absent or [] when unknown. */
  models?: OptionChoice[];
  /** The efforts that conversation's model offered; absent or [] when unknown or it has none. */
  efforts?: OptionChoice[];
}

/** One choice an agent offers for a setting: its value, which the host passes on, and the name to show for it. */
export interface OptionChoice {
  value: string;
  name: string;
}

/**
 * The model a profile seat most likely runs on: the one chosen for it, named as the profile's agent offers it, else the
 * one the profile's latest conversation ran on; with the chosen effort, else the profile's. Null when unknown.
 */
export function expectedModel(profile: ProfileInfo | undefined, choice: SeatChoice | undefined): ModelInfo | null {
  const named = (list: OptionChoice[] | undefined, wanted: string) => offered(list, wanted)?.name ?? wanted;
  const name = choice?.model ? named(profile?.models, choice.model) : profile?.model?.name;
  if (!name) return null;
  // Another model than the profile's latest may have other efforts, or none: its effort is unknown until it runs.
  const ownEffort = name === profile?.model?.name ? profile.model.effort : null;
  const effort = choice?.effort ? named(profile?.efforts, choice.effort) : ownEffort;
  return { name, effort };
}

/** The choice on offer that `wanted` names, by its value or its name, in any case; undefined when none does. */
export function offered(list: OptionChoice[] | undefined, wanted: string): OptionChoice | undefined {
  const lower = wanted.trim().toLowerCase();
  return list?.find((each) => each.value === wanted) ?? list?.find((each) => each.value.toLowerCase() === lower || each.name.toLowerCase() === lower);
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
