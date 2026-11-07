/** The review's setup: what it reviews (set by the agent), profile, depth, the council's seats and instructions; Start review hands it to the host. */
import { useEffect, useRef, useState } from "react";
import { MOCK_AGENTS, isProfileAgent, modelLabel, profileAgent, profileName, type ProfileInfo } from "../core/agents.ts";
import type { Review, Reviewer } from "../core/model.ts";
import { DEPTH_LABELS, PROFILES } from "../core/profiles.ts";
import { setupOf } from "../core/review.ts";
import { DEPTHS, MAX_SEATS, PROFILE_IDS, type Seat, type SetupPatch } from "../core/schemas.ts";
import type { CouncilBridge } from "./bridge.ts";
import { cx } from "./ui.tsx";

/** A text field that keeps what the user types and sends it when they pause or leave the field. */
function useDraft(value: string, commit: (text: string) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const flush = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (text !== value) commit(text);
  };
  return {
    value: draft,
    onChange: (text: string) => {
      setDraft(text);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(text), 600);
    },
    onBlur: () => flush(draft),
  };
}

/** The last part of a path: the project's folder, or the document's file name. */
const nameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const OTHER = "__other__";

/** The profiles the host can list, with the model each last ran on; [] where the host can't tell. */
function useProfiles(bridge: CouncilBridge | undefined): ProfileInfo[] {
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    Promise.resolve(bridge.send({ kind: "profiles" })).then(
      (result) => {
        const list = (result as { profiles?: unknown } | null)?.profiles;
        if (!live) return;
        const clean: ProfileInfo[] = [];
        if (Array.isArray(list)) {
          for (const each of list) {
            // Tolerate a host that still answers with bare names.
            const item = typeof each === "string" ? { name: each, harness: "", model: null } : (each as Partial<ProfileInfo> | null);
            if (item && typeof item.name === "string" && item.name.trim() !== "") clean.push({ name: item.name, harness: item.harness ?? "", model: item.model ?? null });
          }
        }
        setProfiles(clean);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  return profiles;
}

/** The agent a harness id names, as Mirador shows it. */
const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", pi: "pi", opencode: "opencode", codex: "Codex" };
const harnessName = (harness: string) => HARNESS_NAMES[harness] ?? harness;

const profileOption = (profile: ProfileInfo) => (profile.model ? `${modelLabel(profile.model)} \u2014 ${profile.name}` : profile.harness ? `${profile.name} (${harnessName(profile.harness)})` : profile.name);

function SeatCard({
  index,
  seat,
  reviewer,
  profiles,
  canRemove,
  other,
  setOther,
  setAgent,
  remove,
}: {
  index: number;
  seat: Seat;
  reviewer: Reviewer | undefined;
  profiles: ProfileInfo[];
  canRemove: boolean;
  /** "Other profile…" is chosen: a name is typed rather than picked. */
  other: boolean;
  setOther(other: boolean): void;
  setAgent(index: number, agent: string): void;
  remove(index: number): void;
}) {
  const isProfile = isProfileAgent(seat.agent);
  const saved = isProfile ? profileName(seat.agent) : "";
  const listed = isProfile && profiles.some((profile) => profile.name === saved);
  const [name, setName] = useState(saved);
  useEffect(() => {
    setName(saved);
  }, [saved]);
  const commit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return setName(saved);
    setName(trimmed);
    if (trimmed !== saved) setAgent(index, profileAgent(trimmed));
    // A name from the list shows as that option; any other shows as its own.
    setOther(false);
  };
  const showOther = other;
  const mock = MOCK_AGENTS.find((agent) => agent.id === seat.agent);
  const info = profiles.find((profile) => profile.name === saved);
  const model = reviewer?.model ?? info?.model ?? null;
  const harness = info?.harness ? harnessName(info.harness) : "";
  const detail = isProfile
    ? model
      ? `${modelLabel(model)}${harness ? ` on ${harness}` : ""} (what this profile ran last)`
      : harness
        ? `Runs on ${harness}. Model shown once it starts`
        : "Model shown once it starts"
    : (mock?.blurb ?? "");
  const n = index + 1;
  return (
    <div className="seat">
      <div className="seat-head">
        <strong>Reviewer {n}</strong>
        <button type="button" className="seat-remove" onClick={() => remove(index)} disabled={!canRemove} aria-label={`Remove reviewer ${n}`} title={canRemove ? "Remove this reviewer" : "A council needs at least one reviewer"}>
          {"\u00d7"}
        </button>
      </div>
      <select
        value={showOther ? OTHER : seat.agent}
        onChange={(event) => {
          if (event.target.value === OTHER) setOther(true);
          else {
            setOther(false);
            setAgent(index, event.target.value);
          }
        }}
        aria-label={`Agent for reviewer ${n}`}
      >
        {profiles.length > 0 && (
          <optgroup label="Mirador profiles">
            {profiles.map((profile) => (
              <option key={profile.name} value={profileAgent(profile.name)}>
                {profileOption(profile)}
              </option>
            ))}
          </optgroup>
        )}
        {isProfile && !listed && !showOther && <option value={seat.agent}>{saved}</option>}
        <optgroup label="Mock reviewers (demo)">
          {MOCK_AGENTS.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label} (mock)
            </option>
          ))}
        </optgroup>
        <option value={OTHER}>Other profile{"\u2026"}</option>
      </select>
      {showOther && (
        <input
          className="seat-name"
          type="text"
          value={name}
          placeholder="Profile name"
          aria-label={`Mirador profile for reviewer ${n}`}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => commit(name)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
      )}
      <span className="hint">{showOther && saved === "" ? "Name a Mirador profile to seat it, or pick another agent." : detail}</span>
    </div>
  );
}

export function Setup({ review, configure, start, busy, bridge }: { review: Review; configure(patch: SetupPatch): void; start(): void; busy: boolean; bridge?: CouncilBridge }) {
  const setup = setupOf(review);
  const profiles = useProfiles(bridge);
  const instructions = useDraft(setup.instructions, (text) => configure({ instructions: text }));
  // Old reviews may hold disabled seats: they aren't shown, and the first edit drops them.
  const stored = setup.seats.filter((seat) => seat.enabled);
  const storedKey = stored.map((seat) => seat.agent).join("\n");
  // The seats as last sent, until the review catches up: quick edits build on each other rather than on a stale review.
  const [draft, setDraft] = useState<Seat[] | null>(null);
  useEffect(() => {
    setDraft((sent) => (sent && sent.map((seat) => seat.agent).join("\n") === storedKey ? null : sent));
  }, [storedKey]);
  const seats = draft ?? stored;
  const count = seats.length;
  const seatedReviewers = review.reviewers.filter((reviewer) => reviewer.enabled);
  /** The positions of seats in "Other profile…" mode. */
  const [others, setOthers] = useState<number[]>([]);
  const send = (list: Seat[]) => {
    const next = list.map((seat) => ({ agent: seat.agent, enabled: true }));
    setDraft(next);
    configure({ seats: next });
  };
  const setAgent = (index: number, agent: string) => send(seats.map((seat, at) => (at === index ? { agent, enabled: true } : seat)));
  const remove = (index: number) => {
    send(seats.filter((_, at) => at !== index));
    setOthers((list) => list.filter((at) => at !== index).map((at) => (at > index ? at - 1 : at)));
  };
  const setOther = (index: number, other: boolean) => setOthers((list) => (other ? [...new Set([...list, index])] : list.filter((at) => at !== index)));
  const add = () => {
    const taken = new Set(seats.map((seat) => seat.agent));
    const next = profiles.find((profile) => !taken.has(profileAgent(profile.name)));
    const agent = next ? profileAgent(next.name) : (MOCK_AGENTS.find((each) => !taken.has(each.id)) ?? MOCK_AGENTS[0]!).id;
    send([...seats, { agent, enabled: true }]);
  };
  // A seat switched to "Other profile…" keeps its old agent until a profile is named: it mustn't start as that.
  const unnamed = others.filter((at) => seats[at] && !isProfileAgent(seats[at]!.agent)).map((at) => at + 1);

  return (
    <div className="setup">
      <section className="field">
        <span className="field-label">Reviewing</span>
        <p className="reviewing-target">
          <strong>{nameOf(setup.target)}</strong> <span className="mono muted">{setup.target}</span>
        </p>
        <p className="hint">To review something else, such as a single document, ask the agent.</p>
      </section>

      <section className="field">
        <span className="field-label">Review profile</span>
        <div className="choice-grid profiles" role="radiogroup" aria-label="Review profile">
          {PROFILE_IDS.map((id) => (
            <button key={id} role="radio" aria-checked={setup.profile === id} className={cx("choice", setup.profile === id && "chosen")} onClick={() => configure({ profile: id })}>
              <span className="choice-title">{PROFILES[id].title}</span>
              <span className="choice-blurb">{PROFILES[id].blurb}</span>
            </button>
          ))}
        </div>
        <p className="hint">Looks at: {PROFILES[setup.profile].focus.join(" · ")}</p>
      </section>

      <section className="field">
        <span className="field-label">Depth</span>
        <div className="segmented" role="radiogroup" aria-label="Depth">
          {DEPTHS.map((depth) => (
            <button key={depth} role="radio" aria-checked={setup.depth === depth} className={cx(setup.depth === depth && "chosen")} onClick={() => configure({ depth })} title={DEPTH_LABELS[depth].blurb}>
              {DEPTH_LABELS[depth].title}
            </button>
          ))}
        </div>
        <p className="hint">{DEPTH_LABELS[setup.depth].blurb}</p>
      </section>

      <section className="field">
        <span className="field-label">
          Council <span className="muted">· {count} reviewer{count === 1 ? "" : "s"}</span>
        </span>
        <div className="seats">
          {seats.map((seat, index) => (
            <SeatCard
              key={`${index}:${seat.agent}`}
              index={index}
              seat={seat}
              reviewer={seatedReviewers[index]?.agent === seat.agent ? seatedReviewers[index] : undefined}
              profiles={profiles}
              canRemove={count > 1}
              other={others.includes(index)}
              setOther={(other) => setOther(index, other)}
              setAgent={setAgent}
              remove={remove}
            />
          ))}
        </div>
        <div className="seats-add">
          <button type="button" onClick={add} disabled={count >= MAX_SEATS}>
            + Add reviewer
          </button>
          {count >= MAX_SEATS && <span className="hint">At most {MAX_SEATS} reviewers.</span>}
        </div>
        <p className="hint">A profile seat runs a real agent on that profile's default model and effort, each turn in a new conversation. Reviewers only read the target.</p>
      </section>

      <section className="field">
        <label className="field-label" htmlFor="instructions">
          Instructions <span className="muted">· optional</span>
        </label>
        <textarea
          id="instructions"
          rows={3}
          value={instructions.value}
          onChange={(event) => instructions.onChange(event.target.value)}
          onBlur={instructions.onBlur}
          placeholder="What should the council pay particular attention to?"
        />
      </section>

      <div className="setup-actions">
        <button
          className="primary"
          disabled={busy || count === 0 || unnamed.length > 0}
          onClick={() => {
            instructions.onBlur();
            start();
          }}
        >
          Start review
        </button>
        {count === 0 && <span className="hint">Seat at least one reviewer.</span>}
        {unnamed.length > 0 && <span className="hint">Name the profile for reviewer {unnamed.join(", ")}, or pick another agent.</span>}
      </div>
    </div>
  );
}
