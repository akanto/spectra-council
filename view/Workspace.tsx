/** The live workspace: one panel per seat, what each reviewer is doing, and the findings as they come in. */
import { useEffect, useState } from "react";
import { isFinished, isResumable, isRulable, reportersOf, type Activity, type Finding, type Review, type Reviewer } from "../core/model.ts";
import type { ViewAction } from "../core/schemas.ts";
import { seatDetail } from "../core/agents.ts";
import { bySeverity } from "../core/describe.ts";
import { canFetchReply } from "../core/late-replies.ts";
import { ActionPlan } from "./Actions.tsx";
import { cx, elapsed, FindingStatusBadge, AlsoMark, FixBadge, RulingMark, SeverityBadge, StatusMark, statusWord, VerdictBanner } from "./ui.tsx";

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

/** Whether the user can take a reviewer off the council: once it failed, after the start. */
export const removable = (review: Review, reviewer: Reviewer) => review.phase !== "setup" && reviewer.enabled && reviewer.status === "failed";

/** What Remove does to a failed reviewer, for its tooltip: its findings go too while nobody has weighed them. */
export function removeHint(review: Review, reviewer: Reviewer) {
  const unweighed = review.phase === "independent-review" || (review.phase === "interrupted" && review.interruptedPhase === "independent-review");
  return `Take ${reviewer.label} off the council: its panel and positions go${unweighed ? ", and its findings so far" : ""}`;
}

/** What fetching a failed reviewer's late reply does, for its tooltip. */
export function fetchHint(review: Review, reviewer: Reviewer) {
  const after = review.phase === "complete" ? (review.rounds === 0 ? "; with two reviewers' findings, the council then deliberates" : "; its findings come in after the verdict, not deliberated") : "";
  return `Take the reply ${reviewer.label}'s conversation gave after its turn was given up on, if it has ended${after}`;
}

function SeatPanel({ review, reviewer, findings, argued, now, open, expanded, retry, fetch, remove, busy }: { review: Review; reviewer: Reviewer; findings: number; argued: number; now: number; open(from: HTMLElement): void; expanded: boolean; retry: (() => void) | null; fetch: (() => void) | null; remove: (() => void) | null; busy: boolean }) {
  const recent = reviewer.activity.filter((activity) => activity.kind !== "status").slice(-3);
  return (
    <div className="seat-cell">
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
    {(retry || fetch || remove) && (
      <span className="seat-actions">
        {fetch && (
          <button onClick={fetch} disabled={busy} title={fetchHint(review, reviewer)}>
            Fetch its reply
          </button>
        )}
        {retry && (
          <button onClick={retry} disabled={busy}>
            Retry {reviewer.label}
          </button>
        )}
        {remove && (
          <button onClick={remove} disabled={busy} title={removeHint(review, reviewer)}>
            Remove
          </button>
        )}
      </span>
    )}
    </div>
  );
}

export function FindingRow({ review, finding, reviewer, onOpen }: { review: Review; finding: Finding; reviewer: string; onOpen(): void }) {
  return (
    <li>
      <button className="finding-row" onClick={onOpen}>
        <span className="finding-id mono">{finding.id}</span>
        <span className="finding-title">{finding.title}</span>
        <AlsoMark review={review} finding={finding} />
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
function RerunPanel({ review, rerun, resume, quiet }: { review: Review; rerun(): Promise<unknown>; resume(): Promise<unknown>; quiet?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "resumed" | { error: string }>("idle");
  // What was asked belongs to the phase it was asked in: a new stop or interruption starts afresh.
  useEffect(() => {
    setState("idle");
  }, [review.phase, review.startedAt]);
  const ended = review.phase === "stopped" || review.phase === "interrupted";
  if (!isFinished(review) || ended === !!quiet) return null;
  const resumable = isResumable(review);
  const go = (run: () => Promise<unknown>, done: "sent" | "resumed") => {
    setState("sending");
    run().then(
      () => setState(done),
      (error) => setState({ error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const locked = state === "sending" || state === "sent" || state === "resumed";
  const button = (
    <button className={ended && !resumable ? "primary" : "rerun-quiet"} disabled={locked} onClick={() => go(rerun, "sent")}>
      Run again with the same setup
    </button>
  );
  const resumeButton = resumable ? (
    <button className="primary" disabled={locked} onClick={() => go(resume, "resumed")}>
      Resume where it stopped
    </button>
  ) : null;
  const result = state === "sent" ? <span className="rerun-result">Asked the agent to open a new review</span> : state === "resumed" ? <span className="rerun-result">Asked the agent to resume the review</span> : typeof state === "object" ? <span className="rerun-result rerun-error" role="alert">{state.error}</span> : null;
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
      {resumable && <p className="rerun-why">Resuming redoes only the work that was in flight.</p>}
      <div className="rerun">
        {resumeButton}
        {button}
        {result}
      </div>
    </section>
  );
}

/** Reopened fixes first, then standing findings nobody has ruled on, other standing ones, the rest, withdrawn last. */
const attention = (review: Review, finding: Finding) => {
  const rulable = isRulable(review, finding);
  return finding.fix?.state === "reopened" ? 0 : rulable && !finding.ruling ? 1 : rulable ? 2 : finding.status === "withdrawn" ? 4 : 3;
};
const byAttention = (review: Review) => (a: Finding, b: Finding) => attention(review, a) - attention(review, b) || bySeverity(a, b);

export function Workspace({ review, now, openReviewer, openedReviewer, openFinding, openAll, openCouncil, rerun, resume, act, busy, openPath }: { review: Review; now: number; openReviewer(id: string, from: HTMLElement): void; openedReviewer: string | null; openFinding(id: string): void; openAll(): void; openCouncil(): void; rerun(): Promise<unknown>; resume(): Promise<unknown>; act(action: ViewAction): void; busy: boolean; openPath?: (path: string) => void }) {
  const counts = new Map<string, number>();
  for (const finding of review.findings) {
    for (const reviewerId of reportersOf(finding)) counts.set(reviewerId, (counts.get(reviewerId) ?? 0) + 1);
  }
  const argued = new Map<string, number>();
  for (const argument of review.arguments) argued.set(argument.reviewerId, (argued.get(argument.reviewerId) ?? 0) + 1);
  const label = (id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  const top = [...review.findings].sort(byAttention(review)).slice(0, 6);
  return (
    <div className="workspace">
      <RerunPanel review={review} rerun={rerun} resume={resume} />
      <VerdictBanner review={review} />
      <ActionPlan review={review} act={act} busy={busy} openCouncil={openCouncil} compact {...(openPath ? { openPath } : {})} />
      <div className={cx("seat-grid", `seats-${seated.length}`)}>
        {seated.map((reviewer) => (
          <SeatPanel key={reviewer.id} review={review} reviewer={reviewer} findings={counts.get(reviewer.id) ?? 0} argued={argued.get(reviewer.id) ?? 0} now={now} open={(from) => openReviewer(reviewer.id, from)} expanded={openedReviewer === reviewer.id} retry={review.phase === "independent-review" && reviewer.status === "failed" ? () => act({ kind: "retry", reviewerId: reviewer.id }) : null} fetch={canFetchReply(review, reviewer) ? () => act({ kind: "fetch-reply", reviewerId: reviewer.id }) : null} remove={removable(review, reviewer) ? () => act({ kind: "remove", reviewerId: reviewer.id }) : null} busy={busy} />
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
              <FindingRow key={finding.id} review={review} finding={finding} reviewer={label(finding.reviewerId)} onOpen={() => openFinding(finding.id)} />
            ))}
          </ul>
        )}
        {review.findings.length > top.length && (
          <button className="link more" onClick={openAll}>
            All {review.findings.length} findings →
          </button>
        )}
      </section>
      <RerunPanel review={review} rerun={rerun} resume={resume} quiet />
    </div>
  );
}
