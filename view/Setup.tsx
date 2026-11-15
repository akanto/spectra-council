/** The review's setup: what it reviews (set by the agent), profile, depth, the council's seats and instructions; Start review hands it to the host. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MOCK_AGENTS, UNNAMED_PROFILE, choiceOf, expectedModel, isMockAgent, offered, isProfileAgent, modelLabel, profileAgent, profileName, type OptionChoice, type ProfileInfo } from "../core/agents.ts";
import type { Review, Reviewer } from "../core/model.ts";
import { DEPTH_TITLES, ROUNDS_RANGE, knobsText, maxRangeOf, plannedTurns } from "../core/depth.ts";
import { PROFILES } from "../core/profiles.ts";
import { setupOf } from "../core/review.ts";
import { defaultAnswerFile } from "../core/research.ts";
import { DEPTHS, MAX_SEATS, MODEL_CHOICE_MAX, PROFILE_IDS, type Seat, type SetupPatch } from "../core/schemas.ts";
import type { CouncilBridge } from "./bridge.ts";
import { cx } from "./ui.tsx";

/** A text field that keeps what the user types and sends it when they pause or leave the field. */
function useDraft(value: string, commit: (text: string) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
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

/**
 * A whole-number input. What is typed is sent once the typing pauses (or on blur or Enter), clamped to the range, so
 * "12" goes as 12, not as 1 then 12. An invalid entry shows the review's value again on blur. It stays enabled while an
 * action is in flight: disabling it would drop the focus mid-number.
 */
function KnobInput({ id, label, value, min, max, commit }: { id: string; label: string; value: number; min: number; max: number; commit(value: number): void }) {
  const [text, setText] = useState(String(value));
  const input = useRef<HTMLInputElement>(null);
  // Picking "Other profile…" moves the focus to the name field, also from the keyboard.
  const focusName = useRef(false);
  useEffect(() => {
    if (focusName.current && input.current) {
      focusName.current = false;
      input.current.focus();
    }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The value last sent, so a quick change back to the review's (still stale) value is sent too.
  const sent = useRef(value);
  useEffect(() => {
    sent.current = value;
    if (document.activeElement !== input.current) setText(String(value));
  }, [value]);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const flush = (raw: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n)) return null;
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== sent.current) {
      sent.current = clamped;
      commit(clamped);
    }
    return clamped;
  };
  return (
    <label className="knob" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        ref={input}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => flush(raw), 500);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flush(text);
        }}
        onBlur={() => {
          const kept = flush(text);
          setText(String(kept ?? sent.current));
        }}
      />
    </label>
  );
}

/** The last part of a path: the project's folder, or the document's file name. */
const nameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** A research seat's optional focus (an RQ, a set of venues): a lean, the whole brief still. */
function SeatFocus({ index, value, commit }: { index: number; value: string; commit(text: string): void }) {
  const focus = useDraft(value, (text) => commit(text.trim()));
  return (
    <label className="seat-focus">
      <span className="muted">Focus · optional</span>
      <input type="text" value={focus.value} placeholder="e.g. RQ4, database venues" aria-label={`Focus for seat ${index + 1}`} onChange={(event) => focus.onChange(event.target.value)} onBlur={focus.onBlur} />
    </label>
  );
}

const OTHER = "__other__";

/** The well-formed choices in a host's list of them. */
const choicesIn = (list: unknown): OptionChoice[] =>
  Array.isArray(list)
    ? list.flatMap((each) => {
        const choice = each as Partial<OptionChoice> | null;
        return choice && typeof choice.value === "string" && choice.value.trim() !== "" && typeof choice.name === "string" ? [{ value: choice.value, name: choice.name || choice.value }] : [];
      })
    : [];

/** The profiles the host can list, with the model each runs on and the models and efforts on offer; [] where the host can't tell. */
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
            if (item && typeof item.name === "string" && item.name.trim() !== "") {
              clean.push({ name: item.name, harness: item.harness ?? "", model: item.model ?? null, ...(item.lastRan === true && { lastRan: true }), models: choicesIn(item.models), efforts: choicesIn(item.efforts) });
            }
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

function SeatCard({
  index,
  seat,
  reviewer,
  profiles,
  canRemove,
  offerMocks,
  other,
  setOther,
  setAgent,
  setChoice,
  remove,
  extra,
}: {
  index: number;
  seat: Seat;
  reviewer: Reviewer | undefined;
  profiles: ProfileInfo[];
  canRemove: boolean;
  /** Whether the mock personas are on offer: only in a demo, a review the agent opened with mock seats. */
  offerMocks: boolean;
  /** "Other profile…" is chosen: a name is typed rather than picked. */
  other: boolean;
  setOther(other: boolean): void;
  setAgent(index: number, agent: string): void;
  /** Sets the seat's model or effort; an empty one is the profile's own. */
  setChoice(index: number, key: "model" | "effort", value: string): void;
  remove(index: number): void;
  /** More fields under the seat's choices (a research seat's focus). */
  extra?: ReactNode;
}) {
  const isProfile = isProfileAgent(seat.agent);
  const saved = isProfile ? profileName(seat.agent) : "";
  const listed = isProfile && profiles.some((profile) => profile.name === saved);
  const [name, setName] = useState(saved);
  const input = useRef<HTMLInputElement>(null);
  // Picking "Other profile…" moves the focus to the name field, also from the keyboard.
  const focusName = useRef(false);
  useEffect(() => {
    if (focusName.current && input.current) {
      focusName.current = false;
      input.current.focus();
    }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Not while the name is being typed: a commit coming back would overwrite what was typed since.
    if (document.activeElement !== input.current) setName(saved);
  }, [saved]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  /** Seats a non-empty name; it stays a draft in the field until the user leaves it (done) or keeps typing. */
  const seatName = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const trimmed = text.trim();
    if (trimmed && trimmed !== saved) setAgent(index, profileAgent(trimmed));
    return trimmed;
  };
  const commit = (text: string) => {
    const trimmed = seatName(text);
    if (!trimmed) return setName(saved);
    setName(trimmed);
    // A name from the list shows as that option; any other shows as its own.
    setOther(false);
  };
  const type = (text: string) => {
    setName(text);
    if (timer.current) clearTimeout(timer.current);
    // Seated once the typing pauses, so Start review is ready without leaving the field.
    timer.current = setTimeout(() => seatName(text), 400);
  };
  const showOther = other || seat.agent === UNNAMED_PROFILE;
  const mock = MOCK_AGENTS.find((agent) => agent.id === seat.agent);
  // By name in any case, as Mirador finds a profile.
  const info = profiles.find((profile) => profile.name === saved) ?? profiles.find((profile) => profile.name.toLowerCase() === saved.toLowerCase());
  const choice = choiceOf(seat);
  const model = choice ? expectedModel(info, choice) : (reviewer?.model ?? info?.model ?? null);
  const harness = info?.harness ? harnessName(info.harness) : "";
  // Where the model comes from; unsaid until the profiles are listed, when the host may have named the seat already.
  const modelSource = choice ? "chosen for this seat" : info?.lastRan ? "what this profile ran last" : info ? "this profile's model" : null;
  const detail = isProfile
    ? model
      ? `${modelLabel(model)}${harness ? ` on ${harness}` : ""}${modelSource ? ` (${modelSource})` : ""}`
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
        className="seat-agent"
        value={showOther ? OTHER : seat.agent}
        onChange={(event) => {
          if (event.target.value === OTHER) {
            // The seat waits for a name from here on: Start review mustn't run it as the agent it had before.
            setOther(true);
            setName("");
            focusName.current = true;
            if (seat.agent !== UNNAMED_PROFILE) setAgent(index, UNNAMED_PROFILE);
          } else {
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
                {profile.name}
              </option>
            ))}
          </optgroup>
        )}
        {isProfile && !listed && !showOther && <option value={seat.agent}>{saved}</option>}
        {offerMocks && (
          <optgroup label="Mock reviewers (demo)">
            {MOCK_AGENTS.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} (mock)
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>Other profile{"\u2026"}</option>
      </select>
      {showOther && (
        <input
          className="seat-name"
          type="text"
          ref={input}
          value={name}
          placeholder="Profile name"
          aria-label={`Mirador profile for reviewer ${n}`}
          onChange={(event) => type(event.target.value)}
          onBlur={() => commit(name)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
      )}
      {isProfile && !showOther && (
        <div className="seat-choices">
          <ChoicePicker
            label="Model"
            seat={n}
            value={seat.model ?? ""}
            choices={info?.models ?? []}
            own={info?.model ? `Profile's own (${info.model.name})` : "Profile's own"}
            set={(value) => setChoice(index, "model", value)}
          />
          <ChoicePicker
            label="Effort"
            seat={n}
            value={seat.effort ?? ""}
            choices={info?.efforts ?? []}
            own={info?.model?.effort && !seat.model ? `Profile's own (${info.model.effort})` : "Profile's own"}
            set={(value) => setChoice(index, "effort", value)}
          />
        </div>
      )}
      {extra}
      <span className="hint">{showOther && saved === "" ? "Name a Mirador profile to seat it, or pick another agent." : detail}</span>
    </div>
  );
}

/**
 * A seat's model or effort: one of the choices the profile's agent offered, or the profile's own (""). Where the host
 * knows no choices, a name is typed instead, which Mirador matches to the agent's when the conversation starts.
 */
function ChoicePicker({ label, seat, value, choices, own, set }: { label: string; seat: number; value: string; choices: OptionChoice[]; own: string; set(value: string): void }) {
  const [typed, setTyped] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== input.current) setTyped(value);
  }, [value]);
  const name = `${label} for reviewer ${seat}`;
  if (choices.length === 0) {
    const commit = (text: string) => {
      if (text.trim() !== value) set(text.trim());
    };
    return (
      <label className="seat-choice">
        <span>{label}</span>
        <input
          type="text"
          ref={input}
          value={typed}
          placeholder={own}
          maxLength={MODEL_CHOICE_MAX}
          aria-label={name}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => commit(typed)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
      </label>
    );
  }
  // A choice named by the agent ("Opus 5.5", "High") shows as the one on offer; one not on offer shows as itself.
  const shown = value === "" ? "" : (offered(choices, value)?.value ?? value);
  const known = shown === "" || choices.some((choice) => choice.value === shown);
  return (
    <label className="seat-choice">
      <span>{label}</span>
      <select value={shown} aria-label={name} onChange={(event) => set(event.target.value)}>
        <option value="">{own}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.name}
          </option>
        ))}
        {!known && <option value={shown}>{shown}</option>}
      </select>
    </label>
  );
}

/** Roving tabindex for a radiogroup: arrows move to and choose the neighbouring option (wrapping), Home and End the ends. */
/** The depth radiogroup's options: the presets, then Custom (which sends nothing: the knobs set it). */
const DEPTH_CHOICES = [...DEPTHS, "custom"] as const;

function radioKeys<T>(options: readonly T[], chosen: T, choose: (option: T) => void) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    const last = options.length - 1;
    const at = options.indexOf(chosen);
    const to = event.key === "ArrowRight" || event.key === "ArrowDown" ? (at + 1) % options.length : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (at + last) % options.length : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (to === null) return;
    event.preventDefault();
    choose(options[to]!);
    const buttons = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    buttons[to]?.focus();
  };
}

export function Setup({ review, configure: sendPatch, start, busy, bridge }: { review: Review; configure(patch: SetupPatch): void; start(): Promise<unknown>; busy: boolean; bridge?: CouncilBridge }) {
  const [startState, setStartState] = useState<"idle" | "sending" | "prompted">("idle");
  // A change of setup takes back a Start that asked the agent to start the review, also one still on its way: the host
  // hears the change after the Start, so the user starts the review again as it now is.
  const changedSinceStart = useRef(false);
  const configure = (patch: SetupPatch) => {
    changedSinceStart.current = true;
    setStartState((state) => (state === "prompted" ? "idle" : state));
    sendPatch(patch);
  };
  const requestStart = async () => {
    setStartState("sending");
    changedSinceStart.current = false;
    try {
      const result = await start();
      setStartState((result as { prompted?: boolean } | null)?.prompted && !changedSinceStart.current ? "prompted" : "idle");
    } catch {
      setStartState("idle"); // The sender displays the host's error.
    }
  };
  const setup = setupOf(review);
  const profiles = useProfiles(bridge);
  const instructions = useDraft(setup.instructions, (text) => configure({ instructions: text }));
  const research = setup.kind === "research";
  const brief = useDraft(setup.brief, (text) => configure({ brief: text.trim() }));
  const question = useDraft(setup.question, (text) => configure({ question: text }));
  const answerFile = useDraft(setup.answerFile, (text) => configure({ answerFile: text.trim() }));
  // Old reviews may hold disabled seats: they aren't shown, and the first edit drops them.
  const stored = setup.seats.filter((seat) => seat.enabled);
  const seatKey = (list: Seat[]) => list.map((seat) => [seat.agent, seat.model ?? "", seat.effort ?? "", seat.focus ?? ""].join("\t")).join("\n");
  const storedKey = seatKey(stored);
  // The seats as last sent, until the review catches up: quick edits build on each other rather than on a stale review.
  const [draft, setDraft] = useState<Seat[] | null>(null);
  useEffect(() => {
    setDraft((sent) => (sent && seatKey(sent) === storedKey ? null : sent));
  }, [storedKey]);
  const seats = draft ?? stored;
  // Mocks are a demo, offered only when the review was opened with one seated (the agent seats them only when asked);
  // latched, so switching a demo's seats to profiles doesn't take them away mid-setup.
  const [offerMocks] = useState(() => stored.some((seat) => isMockAgent(seat.agent)));
  const count = seats.length;
  const knobs = { deliberationRounds: setup.deliberationRounds, maxFindings: setup.maxFindings };
  const maxRange = maxRangeOf(setup.kind);
  const noun = research ? "seat" : "reviewer";
  const turns = count > 0 && !research ? plannedTurns(count, knobs, seats.some((seat) => isProfileAgent(seat.agent))) : null;
  const seatedReviewers = review.reviewers.filter((reviewer) => reviewer.enabled);
  /** The positions of seats in "Other profile…" mode. */
  const [others, setOthers] = useState<number[]>([]);
  const send = (list: Seat[]) => {
    const next = list.map((seat) => ({ agent: seat.agent, enabled: true, ...choiceOf(seat), ...(seat.focus ? { focus: seat.focus } : {}) }));
    setDraft(next);
    configure({ seats: next });
  };
  // Another agent starts on its profile's own model and effort: a choice belongs to the profile it was made for.
  const setAgent = (index: number, agent: string) => send(seats.map((seat, at) => (at === index ? { agent, enabled: true, ...(seat.focus ? { focus: seat.focus } : {}) } : seat)));
  const setChoice = (index: number, key: "model" | "effort", value: string) =>
    send(
      seats.map((seat, at) => {
        if (at !== index) return seat;
        const { [key]: _, ...rest } = seat;
        return value.trim() ? { ...rest, [key]: value.trim() } : rest;
      }),
    );
  const remove = (index: number) => {
    send(seats.filter((_, at) => at !== index));
    setOthers((list) => list.filter((at) => at !== index).map((at) => (at > index ? at - 1 : at)));
  };
  const setFocus = (index: number, text: string) =>
    send(
      seats.map((seat, at) => {
        if (at !== index) return seat;
        const { focus: _, ...rest } = seat;
        return text ? { ...rest, focus: text } : rest;
      }),
    );
  const setOther = (index: number, other: boolean) => setOthers((list) => (other ? [...new Set([...list, index])] : list.filter((at) => at !== index)));
  const add = () => {
    const taken = new Set(seats.map((seat) => seat.agent));
    const next = profiles.find((profile) => !taken.has(profileAgent(profile.name)));
    // Never a mock by itself: with every known profile seated, the new seat waits for a profile's name.
    const agent = next ? profileAgent(next.name) : UNNAMED_PROFILE;
    send([...seats, { agent, enabled: true }]);
  };
  // A seat switched to "Other profile…" becomes unnamed at once (SeatCard), so the review can't start as its old agent.
  const noBrief = research && !brief.value.trim() && !question.value.trim() && !setup.brief.trim() && !setup.question.trim();
  const unnamed = seats.flatMap((seat, at) => (seat.agent === UNNAMED_PROFILE ? [at + 1] : []));

  return (
    <div className="setup">
      {research ? (
        <>
          <section className="field">
            <label className="field-label" htmlFor="brief">
              Brief
            </label>
            <input id="brief" type="text" className="mono" value={brief.value} placeholder="/absolute/path/to/brief.md" onChange={(event) => brief.onChange(event.target.value)} onBlur={brief.onBlur} />
            <p className="hint">A Markdown file that states the research questions, where to look, the rules for sources and the answer's shape. The workspace, {nameOf(setup.target)}, is readable context.</p>
            <label className="field-label" htmlFor="question">
              … or a question <span className="muted">· saved as the brief when you start</span>
            </label>
            <textarea id="question" rows={3} value={question.value} onChange={(event) => question.onChange(event.target.value)} onBlur={question.onBlur} placeholder="What should the council research?" />
          </section>

          <section className="field">
            <label className="field-label" htmlFor="answer-file">
              Answer file <span className="muted">· optional</span>
            </label>
            <input id="answer-file" type="text" className="mono" value={answerFile.value} placeholder={setup.brief ? defaultAnswerFile(setup.brief) : "<brief name>-answer.md beside the brief"} onChange={(event) => answerFile.onChange(event.target.value)} onBlur={answerFile.onBlur} />
            <p className="hint">The plugin writes the editor's answer here, and again after each revision; researchers only read.</p>
          </section>
        </>
      ) : (
        <>
      <section className="field">
        <span className="field-label">Reviewing</span>
        <p className="reviewing-target">
          <strong>{nameOf(setup.target)}</strong> <span className="mono muted">{setup.target}</span>
        </p>
        <p className="hint">To review something else, such as a single document, ask the agent.</p>
      </section>

      <section className="field">
        <span className="field-label">Review profile</span>
        <div className="choice-grid profiles" role="radiogroup" aria-label="Review profile" onKeyDown={radioKeys(PROFILE_IDS, setup.profile, (id) => configure({ profile: id }))}>
          {PROFILE_IDS.map((id) => (
            <button key={id} role="radio" tabIndex={setup.profile === id ? 0 : -1} aria-checked={setup.profile === id} className={cx("choice", setup.profile === id && "chosen")} onClick={() => configure({ profile: id })}>
              <span className="choice-title">{PROFILES[id].title}</span>
              <span className="choice-blurb">{PROFILES[id].blurb}</span>
            </button>
          ))}
        </div>
        <p className="hint">Looks at: {PROFILES[setup.profile].focus.join(" · ")}</p>
      </section>
        </>
      )}

      <section className="field">
        <span className="field-label">Depth</span>
        <div className="segmented" role="radiogroup" aria-label="Depth" onKeyDown={radioKeys(DEPTH_CHOICES, setup.depth, (depth) => depth !== "custom" && configure({ depth }))}>
          {DEPTHS.map((depth) => (
            <button key={depth} role="radio" tabIndex={setup.depth === depth ? 0 : -1} aria-checked={setup.depth === depth} className={cx(setup.depth === depth && "chosen")} onClick={() => configure({ depth })}>
              {DEPTH_TITLES[depth]}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            tabIndex={setup.depth === "custom" ? 0 : -1}
            aria-checked={setup.depth === "custom"}
            className={cx(setup.depth === "custom" && "chosen")}
            onClick={() => document.getElementById("knob-rounds")?.focus()}
            title="Set the numbers below to something other than a preset"
          >
            {DEPTH_TITLES.custom}
          </button>
        </div>
        <div className="knobs">
          <KnobInput id="knob-rounds" label="Deliberation rounds" value={setup.deliberationRounds} min={ROUNDS_RANGE.min} max={ROUNDS_RANGE.max} commit={(deliberationRounds) => configure({ deliberationRounds })} />
          <KnobInput id="knob-findings" label={research ? "Max claims per researcher" : "Max findings per reviewer"} value={setup.maxFindings} min={maxRange.min} max={maxRange.max} commit={(maxFindings) => configure({ maxFindings })} />
        </div>
        <p className="hint">
          {DEPTH_TITLES[setup.depth]}: {knobsText(knobs, setup.kind)}.
        </p>
        {turns && (
          <p className="hint">
            {count < 2
              ? `Up to ${turns.total} agent turn${turns.total === 1 ? "" : "s"}: ${turns.review} review (no deliberation with one reviewer).`
              : `Up to ${turns.total} agent turns: ${[
                  [turns.review, "review"],
                  [turns.grouping, "grouping"],
                  [turns.rounds, "in rounds"],
                  [turns.proposals, "fix proposal"],
                ]
                  .filter(([n]) => (n as number) > 0)
                  .map(([n, what]) => (what === "grouping" || what === "in rounds" ? `${n} ${what}` : `${n} ${what}${n === 1 ? "" : "s"}`))
                  .join(", ")}. Not counted: retries, re-asking after an unreadable reply (up to one more per turn), and fix re-checks.`}
          </p>
        )}
      </section>

      <section className="field">
        <span className="field-label">
          Council <span className="muted">· {count} {noun}{count === 1 ? "" : "s"}</span>
        </span>
        <div className="seats">
          {seats.map((seat, index) => (
            <SeatCard
              // By position only: a seat that changes agent (a name seated while typing) keeps its card and the focus.
              key={index}
              index={index}
              seat={seat}
              reviewer={seatedReviewers[index]?.agent === seat.agent ? seatedReviewers[index] : undefined}
              profiles={profiles}
              canRemove={count > 1}
              offerMocks={offerMocks || isMockAgent(seat.agent)}
              other={others.includes(index)}
              setOther={(other) => setOther(index, other)}
              setAgent={setAgent}
              setChoice={setChoice}
              remove={remove}
              {...(research ? { extra: <SeatFocus index={index} value={seat.focus ?? ""} commit={(text) => setFocus(index, text)} /> } : {})}
            />
          ))}
        </div>
        <div className="seats-add">
          <button type="button" onClick={add} disabled={count >= MAX_SEATS}>
            + Add {noun}
          </button>
          {count >= MAX_SEATS && <span className="hint">At most {MAX_SEATS} {noun}s.</span>}
        </div>
        <p className="hint">A profile seat runs a real agent on that profile's default model and effort, each turn in a new conversation. {research ? "Researchers only read: they and the editor change no file." : "Reviewers only read the target."}</p>
        {research && <p className="hint">Researchers need web search and fetch tools: a seat whose profile has none fails with that reason. Each seat researches the whole brief; a focus only leans it.</p>}
      </section>

      {research && (
        <section className="field">
          <label className="field-label" htmlFor="editor">
            Editor
          </label>
          <select id="editor" value={seats.some((_, at) => `r${at + 1}` === setup.editor) ? setup.editor : "r1"} onChange={(event) => configure({ editor: event.target.value })}>
            {seats.map((_, at) => (
              <option key={at} value={`r${at + 1}`}>
                R{at + 1}
              </option>
            ))}
          </select>
          <p className="hint">The seat that writes the one answer from the claims that stand; the others check the draft.</p>
        </section>
      )}

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
          disabled={busy || startState !== "idle" || count === 0 || unnamed.length > 0 || noBrief}
          onClick={() => {
            // Commit what was typed and not yet left: the start must see it.
            instructions.onBlur();
            if (research) {
              brief.onBlur();
              question.onBlur();
              answerFile.onBlur();
            }
            void requestStart();
          }}
        >
          {research ? "Start research" : "Start review"}
        </button>
        {startState === "prompted" && <span role="status">Asked the agent to start the review… <button className="link" disabled={busy} onClick={() => setStartState("idle")}>Retry start</button></span>}
        {noBrief && <span className="hint">Give a brief file or a question.</span>}
        {count === 0 && <span className="hint">Seat at least one {noun}.</span>}
        {unnamed.length > 0 && <span className="hint">Name the profile for reviewer {unnamed.join(", ")}, or pick another agent.</span>}
      </div>
    </div>
  );
}
