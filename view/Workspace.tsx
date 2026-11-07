/** The live workspace: one panel per seat, what each reviewer is doing, and the findings as they come in. */
import { useState } from "react";
import { isFinished, isStanding, type Activity, type Finding, type Review, type Reviewer } from "../core/model.ts";
import type { ViewAction } from "../core/schemas.ts";
import { seatDetail } from "../core/agents.ts";
import { bySeverity } from "../core/describe.ts";
import { ActionPlan } from "./Actions.tsx";
import { cx, elapsed, FindingStatusBadge, FixBadge, RulingMark, SeverityBadge, StatusMark, statusWord, VerdictBanner } from "./ui.tsx";

const ACTIVITY_ICONS: Record<Activity["kind"], string> = {
  status: "•",
  read: "▤",
  search: "⌕",
  tool: "⚙",
  note: "✎",
  finding: "◆",
  argument: "⇄",
  proposal: "⌥",
  check: "☑",
  error: "!",
};

export function ActivityLine({ activity, openPath, time }: { activity: Activity; openPath?: (path: string) => void; time?: string }) {
  return (
    <li className={`activity activity-${activity.kind}`}>
      {time && <time className="mono muted">{time}</time>}
      <span className="activity-icon" aria-hidden="true">
        {ACTIVITY_ICONS[activity.kind]}
      </span>
      {activity.path && openPath && activity.kind === "read" ? (
        <span className="activity-text">
          Reading{" "}
          <button className="link mono" onClick={(event) => (event.stopPropagation(), openPath(activity.path!))}>
            {activity.path}
          </button>
        </span>
      ) : (
        <span className="activity-text">{activity.text}</span>
      )}
    </li>
  );
}

function SeatPanel({ reviewer, findings, argued, now, open, expanded }: { reviewer: Reviewer; findings: number; argued: number; now: number; open(from: HTMLElement): void; expanded: boolean }) {
  const recent = reviewer.activity.filter((activity) => activity.kind !== "status").slice(-3);
  return (
    <button
      className={cx("seat-panel", `is-${reviewer.status}`)}
      onClick={(event) => open(event.currentTarget)}
      title={`Open ${reviewer.label}'s activity`}
      aria-label={`${reviewer.label}, ${statusWord(reviewer.status).toLowerCase()}, ${findings} finding${findings === 1 ? "" : "s"} — open activity`}
      aria-expanded={expanded}
    >
      <span className="seat-panel-head">
        <span className="seat-panel-name">
          {reviewer.label}
        </span>
        <StatusMark status={reviewer.status} />
      </span>
      <span className="seat-panel-detail">{seatDetail(reviewer)}</span>
      <span className="seat-panel-current">{reviewer.problem ?? reviewer.current ?? statusWord(reviewer.status)}</span>
      <ul className="seat-panel-recent">
        {recent.map((activity) => (
          <ActivityLine key={activity.seq} activity={activity} />
        ))}
      </ul>
      <span className="seat-panel-foot">
        <span>
          Findings <strong>{findings}</strong>
          {argued > 0 && (
            <>
              {" · "}Arguments <strong>{argued}</strong>
            </>
          )}
        </span>
        <span className="muted">{elapsed(reviewer.startedAt, reviewer.endedAt, now) ?? ""}</span>
      </span>
    </button>
  );
}

export function FindingRow({ finding, reviewer, onOpen }: { finding: Finding; reviewer: string; onOpen(): void }) {
  return (
    <li>
      <button className="finding-row" onClick={onOpen}>
        <span className="finding-id mono">{finding.id}</span>
        <span className="finding-title">{finding.title}</span>
        <span className="finding-by muted">{reviewer}</span>
        <SeverityBadge severity={finding.severity} />
        <FindingStatusBadge status={finding.status} />
        <RulingMark finding={finding} />
        <FixBadge finding={finding} />
      </button>
    </li>
  );
}

/** Why a review that ended early is a dead end otherwise: say what happened and offer a new review with the same setup. */
function RerunPanel({ review, rerun, quiet }: { review: Review; rerun(): Promise<unknown>; quiet?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | { error: string }>("idle");
  const ended = review.phase === "stopped" || review.phase === "interrupted";
  if (!isFinished(review) || ended === !!quiet) return null;
  const go = () => {
    setState("sending");
    rerun().then(
      () => setState("sent"),
      (error) => setState({ error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const button = (
    <button className={ended ? "primary" : "rerun-quiet"} disabled={state === "sending" || state === "sent"} onClick={go}>
      Run again with the same setup
    </button>
  );
  const result = state === "sent" ? <span className="rerun-result">Asked the agent to open a new review</span> : typeof state === "object" ? <span className="rerun-result rerun-error" role="alert">{state.error}</span> : null;
  if (!ended)
    return (
      <div className="rerun rerun-quiet-row">
        {button}
        {result}
      </div>
    );
  return (
    <section className="rerun-panel" role="status">
      <strong>{review.phase === "stopped" ? "This review was stopped." : "Mirador restarted while this review ran."}</strong>
      <div className="rerun">
        {button}
        {result}
      </div>
    </section>
  );
}

/** Reopened fixes first, then standing findings nobody has ruled on, other standing ones, the rest, withdrawn last. */
const attention = (finding: Finding) => (finding.fix?.state === "reopened" ? 0 : isStanding(finding) && !finding.ruling ? 1 : isStanding(finding) ? 2 : finding.status === "withdrawn" ? 4 : 3);
const byAttention = (a: Finding, b: Finding) => attention(a) - attention(b) || bySeverity(a, b);

export function Workspace({ review, now, openReviewer, openedReviewer, openFinding, openAll, openCouncil, rerun, act, busy, openPath }: { review: Review; now: number; openReviewer(id: string, from: HTMLElement): void; openedReviewer: string | null; openFinding(id: string): void; openAll(): void; openCouncil(): void; rerun(): Promise<unknown>; act(action: ViewAction): void; busy: boolean; openPath?: (path: string) => void }) {
  const counts = new Map<string, number>();
  for (const finding of review.findings) counts.set(finding.reviewerId, (counts.get(finding.reviewerId) ?? 0) + 1);
  const argued = new Map<string, number>();
  for (const argument of review.arguments) argued.set(argument.reviewerId, (argued.get(argument.reviewerId) ?? 0) + 1);
  const label = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  const top = [...review.findings].sort(byAttention).slice(0, 6);
  return (
    <div className="workspace">
      <RerunPanel review={review} rerun={rerun} />
      <VerdictBanner review={review} />
      <ActionPlan review={review} act={act} busy={busy} openCouncil={openCouncil} compact {...(openPath ? { openPath } : {})} />
      <div className={cx("seat-grid", `seats-${seated.length}`)}>
        {seated.map((reviewer) => (
          <SeatPanel key={reviewer.id} reviewer={reviewer} findings={counts.get(reviewer.id) ?? 0} argued={argued.get(reviewer.id) ?? 0} now={now} open={(from) => openReviewer(reviewer.id, from)} expanded={openedReviewer === reviewer.id} />
        ))}
      </div>
      <section className="findings-summary">
        <header>
          <h2>Findings</h2>
          <span className="count-pill">{review.findings.length} total</span>
        </header>
        {review.findings.length === 0 ? (
          <p className="empty-note">{isFinished(review) ? "No findings were reported." : "No findings yet. They appear here as reviewers report them."}</p>
        ) : (
          <ul className="finding-rows">
            {top.map((finding) => (
              <FindingRow key={finding.id} finding={finding} reviewer={label(finding.reviewerId)} onOpen={() => openFinding(finding.id)} />
            ))}
          </ul>
        )}
        {review.findings.length > top.length && (
          <button className="link more" onClick={openAll}>
            All {review.findings.length} findings →
          </button>
        )}
      </section>
      <RerunPanel review={review} rerun={rerun} quiet />
    </div>
  );
}
