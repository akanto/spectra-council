/** The review's setup: what it reviews (set by the agent), profile, depth, the four seats and instructions; Start review hands it to the host. */
import { useEffect, useRef, useState } from "react";
import { MOCK_AGENTS } from "../core/agents.ts";
import type { Review } from "../core/model.ts";
import { DEPTH_LABELS, PROFILES } from "../core/profiles.ts";
import { setupOf } from "../core/review.ts";
import { DEPTHS, PROFILE_IDS, type Seat, type SetupPatch } from "../core/schemas.ts";
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

export function Setup({ review, configure, start, busy }: { review: Review; configure(patch: SetupPatch): void; start(): void; busy: boolean }) {
  const setup = setupOf(review);
  const instructions = useDraft(setup.instructions, (text) => configure({ instructions: text }));
  const seated = setup.seats.filter((seat) => seat.enabled).length;
  const setSeat = (index: number, seat: Partial<Seat>) => configure({ seats: setup.seats.map((each, at) => (at === index ? { ...each, ...seat } : each)) });

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
          Council <span className="muted">· {seated} of {setup.seats.length} seats taken</span>
        </span>
        <div className="seats">
          {setup.seats.map((seat, index) => (
            <div key={index} className={cx("seat", seat.enabled && "seated")}>
              <label className="seat-toggle">
                <input type="checkbox" checked={seat.enabled} onChange={(event) => setSeat(index, { enabled: event.target.checked })} />
                <span>Seat {index + 1}</span>
              </label>
              <select value={seat.agent} onChange={(event) => setSeat(index, { agent: event.target.value })} aria-label={`Agent in seat ${index + 1}`}>
                {MOCK_AGENTS.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label} (mock)
                  </option>
                ))}
              </select>
              <span className="hint">{MOCK_AGENTS.find((agent) => agent.id === seat.agent)?.blurb}</span>
            </div>
          ))}
        </div>
        <p className="hint">Reviewers are deterministic mocks in this version: they read your real file list, but their findings are illustrative.</p>
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
          disabled={busy || seated === 0}
          onClick={() => {
            instructions.onBlur();
            start();
          }}
        >
          Start review
        </button>
        {seated === 0 && <span className="hint">Seat at least one reviewer.</span>}
      </div>
    </div>
  );
}
