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
function TakeOut({ finding, act, busy }: { finding: Finding; act: Act; busy: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <p>
        <button className="take-out" disabled={busy} onClick={() => setAsking(true)}>
          Take out of the fixes
        </button>
      </p>
    );
  const rule = (decision: "dismissed" | "deferred") => act({ kind: "rule", findingId: finding.id, decision, note: "" });
  return (
    <div className="take-out-confirm" role="group" aria-label="Take out of the fixes">
      <span>Take {finding.id} out of the fixes and mark it as</span>
      <button className="segment-dismissed" disabled={busy} onClick={() => rule("dismissed")}>
        Dismiss
      </button>
      <button className="segment-deferred" disabled={busy} onClick={() => rule("deferred")}>
        Later
      </button>
      <button className="link" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}

function FixStatus({ review, finding, openPath, act, busy }: { review: Review; finding: Finding; openPath: OpenPath; act: Act; busy: boolean }) {
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
      {(fix.state === "handed-off" || fix.state === "reopened") && <TakeOut finding={finding} act={act} busy={busy} />}
    </section>
  );
}

/**
 * The user's ruling on a finding; once handed off, the fix's state instead. Once ruled, `next` offers the next finding
 * that needs a ruling (the user moves on themselves, so the note field stays in reach).
 */
export function RulingControl({ review, finding, act, busy, openPath, next }: { review: Review; finding: Finding; act: Act; busy: boolean; openPath: OpenPath; next?: { id: string; go(): void } | null }) {
  const ruling = finding.ruling;
  const [saving, setSaving] = useState<Decision | null>(null);
  useEffect(() => {
    if (!busy) setSaving(null);
  }, [busy]);
  const note = useDraft(ruling?.note ?? "", (text) => {
    if (ruling) act({ kind: "rule", findingId: finding.id, decision: ruling.decision, note: text });
  });
  if (!isStanding(finding)) return null;
  if (finding.fix) return <FixStatus review={review} finding={finding} openPath={openPath} act={act} busy={busy} />;
  const editable = review.phase === "complete";
  const rule = (decision: Decision | null) => {
    setSaving(decision);
    act({ kind: "rule", findingId: finding.id, decision, note: decision ? note.value : "" });
  };
  return (
    <section className={cx("ruling", "ruling-top", !ruling && editable && "needs-ruling")}>
      <div className="ruling-row">
        <h3>{ruling ? "Your ruling" : "Rule on this finding"}</h3>
        <div className="segmented" role="group" aria-label="Your ruling">
          {DECISIONS.map((each) => {
            const chosen = ruling?.decision === each.value;
            return (
              <button key={each.value} className={cx("segment", `segment-${each.value}`, chosen && "chosen")} aria-pressed={chosen} disabled={!editable || (busy && saving === each.value)} onClick={() => rule(chosen ? null : each.value)}>
                {busy && saving === each.value ? "Saving…" : each.label}
              </button>
            );
          })}
        </div>
      </div>
      {ruling && (
        <div className="ruling-row">
          <input className="ruling-note" type="text" placeholder="Note (optional)" aria-label="Note on your ruling" value={note.value} disabled={!editable} onChange={(event) => note.onChange(event.target.value)} onBlur={note.onBlur} />
          {next && editable && (
            <button type="button" onClick={() => (note.onBlur(), next.go())}>
              Next to rule: {next.id} →
            </button>
          )}
        </div>
      )}
      {!editable && !ruling && <p className="hint">You can rule when the review is complete.</p>}
    </section>
  );
}

/** Counts of the user's rulings, the next step that follows from them, and the fixes' progress. */
export function ActionPlan({ review, act, busy, compact, openPath, openCouncil }: { review: Review; act: Act; busy: boolean; compact?: boolean; openPath?: OpenPath; openCouncil?: () => void }) {
  const standing = review.findings.filter(isStanding);
  const fixer = useContext(FixerContext);
  const showable = (review.phase === "complete" || review.phase === "verification") && standing.length > 0;
  if (!showable) return null;
  const count = (decision: Decision) => standing.filter((finding) => finding.ruling?.decision === decision).length;
  const accepted = standing.filter((finding) => finding.ruling?.decision === "accepted");
  const unruledList = standing.filter((finding) => !finding.ruling);
  const unruled = unruledList.length;
  const bulk = unruledList.filter((finding) => finding.status === "agreed" || finding.status === "confirmed");
  const pending = accepted.filter((finding) => finding.fix?.state !== "fixed" && finding.fix?.state !== "verified").length;
  const toHand = accepted.filter((finding) => !finding.fix).length;
  const reopened = standing.filter((finding) => finding.fix?.state === "reopened").length;
  const fixed = standing.filter((finding) => finding.fix?.state === "fixed").length;
  const withFix = (state: string) => standing.filter((finding) => finding.fix?.state === state).length;
  const attention = standing.filter((finding) => finding.fix?.problem).length;
  const hasFixes = standing.some((finding) => finding.fix);
  const running = isRunning(review);
  const off = busy || running;
  const handoff = review.handoff;
  const who = fixer ?? "agent";
  // The one accent-filled button follows the next step; nothing is primary while the user still has to rule.
  const next: "verify" | "fix" | null = unruled > 0 ? null : fixed > 0 ? "verify" : toHand + reopened > 0 ? "fix" : null;
  const fixLabel = toHand === 0 && reopened > 0 ? `Ask ${who} to fix again (${pending})` : `Ask ${who} to fix (${pending})`;
  const instruction =
    running
      ? null
      : unruled > 0
        ? null
        : fixed > 0
          ? "Fixes reported. Re-check them so the reviewers can verify."
          : reopened > 0
            ? "Some fixes were reopened. Ask the fixer to try again."
            : toHand > 0
              ? "Hand the accepted findings to the fixer."
              : accepted.length === 0
                ? "Nothing accepted, so there is nothing to fix."
                : null;
  return (
    <section className={cx("action-plan", unruled > 0 && "needs-ruling")} aria-label="Action plan">
      <div className="action-plan-head">
        <h3>Action plan</h3>
        <span className="action-plan-counts">
          <span className="ruling-count ruling-accepted">{count("accepted")} accepted</span>
          <span className="ruling-count ruling-dismissed">{count("dismissed")} dismissed</span>
          <span className="ruling-count ruling-deferred">{count("deferred")} later</span>
          <span className="ruling-count">{unruled} not ruled yet</span>
        </span>
      </div>
      {unruled > 0 && !running && (
        <p className="next-step" role="status">
          <span>Rule on each finding: Accept, Dismiss or Later.</span> <strong className="left-count">{unruled} left.</strong>
        </p>
      )}
      {instruction && <p className="next-step">{instruction}</p>}
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
          {bulk.length > 0 && !running && (
            <button disabled={busy || review.phase !== "complete"} onClick={() => bulk.forEach((finding) => act({ kind: "rule", findingId: finding.id, decision: "accepted", note: "" }))}>
              Accept all agreed &amp; confirmed ({bulk.length})
            </button>
          )}
          {accepted.length > 0 && (
            <button disabled={off} onClick={() => act({ kind: "handoff" })}>
              {handoff ? "Rewrite hand-off" : "Write hand-off"}
            </button>
          )}
          {pending > 0 && (
            <button className={cx(next === "fix" && "primary")} disabled={off} onClick={() => act({ kind: "fix" })}>
              {fixLabel}
            </button>
          )}
          {fixed > 0 && (
            <button className={cx(next === "verify" && "primary")} disabled={off} onClick={() => act({ kind: "verify" })}>
              Re-check fixes ({fixed})
            </button>
          )}
        </div>
      )}
      {!compact && (accepted.length > 0 || hasFixes) && (
        <p className="hint">
          {fixer
            ? `Fixes go to ${fixer} in a conversation of its own · change it in the conversation header (Spectra Council fixer)`
            : "Fixes go to this conversation's agent · to use another profile or model, pick a Spectra Council fixer in the conversation header"}
        </p>
      )}
      {compact && openCouncil && (
        <p className="action-plan-open">
          <button className="link open-council" onClick={openCouncil}>
            Open Council to rule and fix →
          </button>
        </p>
      )}
      {compact && running && <p className="hint">Re-checking the fixes…</p>}
    </section>
  );
}
