/** The live workspace: one panel per seat, what each reviewer is doing, and the findings as they come in. */
import type { Activity, Finding, Review, Reviewer } from "../core/model.ts";
import { bySeverity } from "../core/describe.ts";
import { cx, elapsed, FindingStatusBadge, SeverityBadge, StatusMark, statusWord, VerdictBanner } from "./ui.tsx";

const ACTIVITY_ICONS: Record<Activity["kind"], string> = {
  status: "•",
  read: "▤",
  search: "⌕",
  tool: "⚙",
  note: "✎",
  finding: "◆",
  argument: "⇄",
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

function SeatPanel({ reviewer, findings, argued, now, mock, open }: { reviewer: Reviewer; findings: number; argued: number; now: number; mock: boolean; open(): void }) {
  if (!reviewer.enabled) {
    return (
      <div className="seat-panel empty">
        <span className="seat-panel-name">Empty seat</span>
        <span className="hint">{reviewer.label} is not taking part.</span>
      </div>
    );
  }
  const recent = reviewer.activity.filter((activity) => activity.kind !== "status").slice(-3);
  return (
    <button className={cx("seat-panel", `is-${reviewer.status}`)} onClick={open} title={`Open ${reviewer.label}'s activity`}>
      <span className="seat-panel-head">
        <span className="seat-panel-name">
          {reviewer.label}
          {mock && <span className="tag">mock</span>}
        </span>
        <StatusMark status={reviewer.status} />
      </span>
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
      </button>
    </li>
  );
}

export function Workspace({ review, now, openReviewer, openFinding }: { review: Review; now: number; openReviewer(id: string): void; openFinding(id: string): void }) {
  const counts = new Map<string, number>();
  for (const finding of review.findings) counts.set(finding.reviewerId, (counts.get(finding.reviewerId) ?? 0) + 1);
  const argued = new Map<string, number>();
  for (const argument of review.arguments) argued.set(argument.reviewerId, (argued.get(argument.reviewerId) ?? 0) + 1);
  const label = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;
  const top = [...review.findings].sort(bySeverity).slice(0, 6);
  return (
    <div className="workspace">
      <VerdictBanner review={review} />
      <div className="seat-grid">
        {review.reviewers.map((reviewer) => (
          <SeatPanel key={reviewer.id} reviewer={reviewer} findings={counts.get(reviewer.id) ?? 0} argued={argued.get(reviewer.id) ?? 0} now={now} mock={review.runner === "mock"} open={() => openReviewer(reviewer.id)} />
        ))}
      </div>
      <section className="findings-summary">
        <header>
          <h2>Findings</h2>
          <span className="count-pill">{review.findings.length} total</span>
        </header>
        {review.findings.length === 0 ? (
          <p className="empty-note">No findings yet. They appear here as reviewers report them.</p>
        ) : (
          <ul className="finding-rows">
            {top.map((finding) => (
              <FindingRow key={finding.id} finding={finding} reviewer={label(finding.reviewerId)} onOpen={() => openFinding(finding.id)} />
            ))}
          </ul>
        )}
        {review.findings.length > top.length && (
          <button className="link more" onClick={() => openFinding(top.at(-1)!.id)}>
            All {review.findings.length} findings →
          </button>
        )}
      </section>
    </div>
  );
}
