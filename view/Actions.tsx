/** After the verdict: the proposed fix, the user's ruling, the fix's progress and the action plan that drives the hand-off. */
import { useContext, useEffect, useRef, useState } from "react";
import { isRunning, isStanding, type Finding, type Review } from "../core/model.ts";
import type { Decision, ViewAction } from "../core/schemas.ts";
import { cx, FIX_WORDS, FixerContext } from "./ui.tsx";

type Act = (action: ViewAction) => void;
type OpenPath = ((path: string) => void) | undefined;

/** A text field that commits on blur or after a pause (same pattern as Setup's draft). */
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
      timer.current = setTimeout(() => flush(text), 800);
    },
    onBlur: () => flush(draft),
  };
}

function FileLink({ path, openPath }: { path: string; openPath: OpenPath }) {
  return openPath ? (
    <button className="link mono" onClick={() => openPath(path)}>
      {path}
    </button>
  ) : (
    <span className="mono">{path}</span>
  );
}

export function ProposalBlock({ review, finding, openPath }: { review: Review; finding: Finding; openPath: OpenPath }) {
  const proposal = finding.proposal;
  if (!proposal) return null;
  const drafter = review.reviewers.find((each) => each.id === proposal.drafterId)?.label ?? proposal.drafterId;
  return (
    <section className="proposal">
      <h3>
        Proposed fix <span className="muted proposal-by">drafted by {drafter}</span>
      </h3>
      <p className="proposal-summary">{proposal.summary}</p>
      {proposal.steps.length > 0 && (
        <ol className="proposal-steps">
          {proposal.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {proposal.files.length > 0 && (
        <p className="proposal-files">
          <span className="muted">Files </span>
          {proposal.files.map((file) => (
            <FileLink key={file} path={file} openPath={openPath} />
          ))}
        </p>
      )}
      <p>
        <strong>Verify: </strong>
        {proposal.verification}
      </p>
      {proposal.risks && (
        <p>
          <strong>Risks: </strong>
          {proposal.risks}
        </p>
      )}
    </section>
  );
}

const DECISIONS: { value: Decision; label: string }[] = [
  { value: "accepted", label: "Accept" },
  { value: "dismissed", label: "Dismiss" },
  { value: "deferred", label: "Later" },
];

/** Where an accepted finding's fix is: what the agent changed, its files, and each reviewer's re-check. */
function FixStatus({ review, finding, openPath }: { review: Review; finding: Finding; openPath: OpenPath }) {
  const fix = finding.fix;
  if (!fix) return null;
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  return (
    <section className="ruling fix-status">
      <h3>
        Fix <span className={cx("badge", `fix-${fix.state}`)}>{FIX_WORDS[fix.state]}</span>
      </h3>
      {finding.ruling?.note && <p className="muted">Your note: {finding.ruling.note}</p>}
      <p className="fix-who muted">
        {fix.fixer ? (fix.fixer.conversationId ? `Handed to ${fix.fixer.profile}` : `Handed to ${fix.fixer.profile} · starting…`) : "Handed to this conversation's agent"}
      </p>
      {fix.problem && (
        <p className="fix-problem" role="alert">
          <strong>Not fixed: </strong>
          {fix.problem}
          <span className="muted"> · “Ask … to fix” in the action plan hands it over again.</span>
        </p>
      )}
      {fix.summary ? <p>{fix.summary}</p> : <p className="muted">Waiting for the agent to report the fix.</p>}
      {fix.files.length > 0 && (
        <p className="proposal-files">
          <span className="muted">Changed </span>
          {fix.files.map((file) => (
            <FileLink key={file} path={file} openPath={openPath} />
          ))}
        </p>
      )}
      {fix.checks.length > 0 && (
        <ul className="fix-checks">
          {fix.checks.map((check, index) => (
            <li key={index} className={"fix-check"}>
              <span className="fix-check-head">
                <strong>{label(check.reviewerId)}</strong>
                <span className={cx("badge", `fix-${check.outcome}`)}>{check.outcome}</span>
                <span className="muted">re-check {check.pass}</span>
              </span>
              <span>{check.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The user's ruling on a finding; once handed off, the fix's state instead. */
export function RulingControl({ review, finding, act, busy, openPath }: { review: Review; finding: Finding; act: Act; busy: boolean; openPath: OpenPath }) {
  const ruling = finding.ruling;
  const note = useDraft(ruling?.note ?? "", (text) => {
    if (ruling) act({ kind: "rule", findingId: finding.id, decision: ruling.decision, note: text });
  });
  if (!isStanding(finding)) return null;
  if (finding.fix) return <FixStatus review={review} finding={finding} openPath={openPath} />;
  const editable = review.phase === "complete";
  const rule = (decision: Decision | null) => act({ kind: "rule", findingId: finding.id, decision, note: decision ? note.value : "" });
  return (
    <section className="ruling">
      <h3>Your ruling</h3>
      <div className="segmented" role="group" aria-label="Your ruling">
        {DECISIONS.map((each) => (
          <button key={each.value} className={cx("segment", `segment-${each.value}`, ruling?.decision === each.value && "chosen")} aria-pressed={ruling?.decision === each.value} disabled={!editable || busy} onClick={() => rule(ruling?.decision === each.value ? null : each.value)}>
            {each.label}
          </button>
        ))}
      </div>
      {ruling && (
        <input className="ruling-note" type="text" placeholder="Note (optional)" aria-label="Note on your ruling" value={note.value} disabled={!editable} onChange={(event) => note.onChange(event.target.value)} onBlur={note.onBlur} />
      )}
      {!editable && !ruling && <p className="hint">You can rule when the review is complete.</p>}
    </section>
  );
}

/** Counts of the user's rulings, the actions that follow from them, and the fixes' progress. */
export function ActionPlan({ review, act, busy, compact, openPath }: { review: Review; act: Act; busy: boolean; compact?: boolean; openPath?: OpenPath }) {
  const standing = review.findings.filter(isStanding);
  const showable = (review.phase === "complete" || review.phase === "verification") && standing.length > 0;
  if (!showable) return null;
  const count = (decision: Decision) => standing.filter((finding) => finding.ruling?.decision === decision).length;
  const accepted = standing.filter((finding) => finding.ruling?.decision === "accepted");
  const unruled = standing.filter((finding) => !finding.ruling).length;
  const pending = accepted.filter((finding) => finding.fix?.state !== "fixed" && finding.fix?.state !== "verified").length;
  const fixed = standing.filter((finding) => finding.fix?.state === "fixed").length;
  const withFix = (state: string) => standing.filter((finding) => finding.fix?.state === state).length;
  const fixer = useContext(FixerContext);
  const attention = standing.filter((finding) => finding.fix?.problem).length;
  const hasFixes = standing.some((finding) => finding.fix);
  const running = isRunning(review);
  const off = busy || running;
  const handoff = review.handoff;
  return (
    <section className="action-plan" aria-label="Action plan">
      <div className="action-plan-head">
        <h3>Action plan</h3>
        <span className="action-plan-counts">
          <span className="ruling-count ruling-accepted">{count("accepted")} accepted</span>
          <span className="ruling-count ruling-dismissed">{count("dismissed")} dismissed</span>
          <span className="ruling-count ruling-deferred">{count("deferred")} later</span>
          <span className="ruling-count">{unruled} not ruled yet</span>
        </span>
      </div>
      {hasFixes && (
        <p className="fix-progress">
          <span className="fix-handed-off">{withFix("handed-off")} handed off</span> · <span className="fix-fixed">{withFix("fixed")} fixed</span> · <span className="fix-verified">{withFix("verified")} verified</span> ·{" "}
          <span className="fix-reopened">{withFix("reopened")} reopened</span>
          {attention > 0 && (
            <>
              {" "}
              · <span className="fix-problem-count">{attention} need attention</span>
            </>
          )}
        </p>
      )}
      {handoff && (
        <p className="handoff-path">
          <span className="muted">Hand-off </span>
          <span className="mono handoff-file" title={handoff.path}>
            <bdi>{handoff.path}</bdi>
          </span>
          {openPath && (
            <button className="link" onClick={() => openPath(handoff.path)}>
              Open
            </button>
          )}
        </p>
      )}
      {!compact && (
        <div className="action-plan-buttons">
          <button disabled={off || accepted.length === 0} onClick={() => act({ kind: "handoff" })}>
            {handoff ? "Rewrite hand-off" : "Write hand-off"}
          </button>
          <button className="primary" disabled={off || pending === 0} onClick={() => act({ kind: "fix" })}>
            Ask {fixer ?? "agent"} to fix ({pending})
          </button>
          <button disabled={off || fixed === 0} onClick={() => act({ kind: "verify" })}>
            Re-check fixes ({fixed})
          </button>
        </div>
      )}
      {!compact && (
        <p className="hint">
          {fixer
            ? `Fixes go to ${fixer} in a conversation of its own · change it in the conversation header (Spectra Council fixer)`
            : "Fixes go to this conversation's agent · to use another profile or model, pick a Spectra Council fixer in the conversation header"}
        </p>
      )}
      {compact && running && <p className="hint">Re-checking the fixes…</p>}
    </section>
  );
}
