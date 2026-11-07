/** One reviewer's full activity and findings, beside the workspace. Only events the runner reported, no private reasoning. */
import { useEffect, useRef } from "react";
import { seatDetail } from "../core/agents.ts";
import { reportersOf, type Review } from "../core/model.ts";
import type { ViewAction } from "../core/schemas.ts";
import { ActivityLine, FindingRow } from "./Workspace.tsx";
import { elapsed, StatusMark, statusWord } from "./ui.tsx";

const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ReviewerDetail({
  review,
  reviewerId,
  now,
  close,
  act,
  busy,
  openFinding,
  openPath,
}: {
  review: Review;
  reviewerId: string;
  now: number;
  close(): void;
  act(action: ViewAction): void;
  busy: boolean;
  openFinding(id: string): void;
  openPath?: (path: string) => void;
}) {
  const reviewer = review.reviewers.find((each) => each.id === reviewerId);
  const end = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  const present = reviewer !== undefined;
  // Opening (or switching reviewer) moves focus to the heading; in the single-column layout the panel sits below the findings, so scroll to it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 720px)").matches) root.current?.scrollIntoView({ block: "start" });
  }, [reviewerId, present]);
  // Esc closes the panel when focus is in it or nowhere in particular, and the caller returns focus to the seat that
  // opened it; an Esc meant for something else (the Stop confirmation, a field) is left alone.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !root.current?.contains(focused)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const count = reviewer?.activity.length ?? 0;
  useEffect(() => {
    // A block body: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  if (!reviewer) return null;
  // Its own findings and those its report of was merged into, as the seat panel counts them.
  const findings = review.findings.filter((finding) => reportersOf(finding).includes(reviewer.id));
  const hidden = reviewer.activityCount - reviewer.activity.length;
  return (
    <aside ref={root} className="detail" aria-label={`${reviewer.label}'s activity`}>
      <header className="detail-head">
        <StatusMark status={reviewer.status} />
        <div>
          <h2 ref={heading} tabIndex={-1}>{reviewer.label}</h2>
          <div className="detail-sub muted">{seatDetail(reviewer)}</div>
          <span className="muted">
            {statusWord(reviewer.status)}
            {reviewer.startedAt !== null && ` · ${elapsed(reviewer.startedAt, reviewer.endedAt, now)}`}
            {` · ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="detail-actions">
          {review.phase === "independent-review" && reviewer.status === "failed" && (
            <button onClick={() => act({ kind: "retry", reviewerId: reviewer.id })} disabled={busy}>
              Retry
            </button>
          )}
          <button className="icon-button" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
      </header>
      {reviewer.problem && <p className="problem">{reviewer.problem}</p>}
      {findings.length > 0 && (
        <section>
          <h3>Findings</h3>
          <ul className="finding-rows compact">
            {findings.map((finding) => (
              <FindingRow key={finding.id} review={review} finding={finding} reviewer="" onOpen={() => openFinding(finding.id)} />
            ))}
          </ul>
        </section>
      )}
      <section className="timeline">
        <h3>Activity</h3>
        {hidden > 0 && <p className="hint">{hidden} earlier events not kept.</p>}
        {reviewer.activity.length === 0 ? (
          <p className="empty-note">Nothing yet.</p>
        ) : (
          <ol className="timeline-list">
            {reviewer.activity.map((activity) => (
              <ActivityLine key={activity.seq} activity={activity} time={clockTime(activity.at)} {...(openPath ? { openPath } : {})} />
            ))}
          </ol>
        )}
        <div ref={end} />
      </section>
    </aside>
  );
}
