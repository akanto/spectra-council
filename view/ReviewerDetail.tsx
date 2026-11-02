/** One reviewer's full activity and findings, beside the workspace. Only events the runner reported, no private reasoning. */
import { useEffect, useRef } from "react";
import type { Review } from "../core/model.ts";
import { ActivityLine, FindingRow } from "./Workspace.tsx";
import { elapsed, StatusMark, statusWord } from "./ui.tsx";

const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ReviewerDetail({
  review,
  reviewerId,
  now,
  close,
  openFinding,
  openPath,
}: {
  review: Review;
  reviewerId: string;
  now: number;
  close(): void;
  openFinding(id: string): void;
  openPath?: (path: string) => void;
}) {
  const reviewer = review.reviewers.find((each) => each.id === reviewerId);
  const end = useRef<HTMLDivElement>(null);
  const count = reviewer?.activity.length ?? 0;
  useEffect(() => {
    // A block body: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  if (!reviewer) return null;
  const findings = review.findings.filter((finding) => finding.reviewerId === reviewer.id);
  const hidden = reviewer.activityCount - reviewer.activity.length;
  return (
    <aside className="detail" aria-label={`${reviewer.label}'s activity`}>
      <header className="detail-head">
        <StatusMark status={reviewer.status} />
        <div>
          <h2>{reviewer.label}</h2>
          <span className="muted">
            {statusWord(reviewer.status)}
            {reviewer.startedAt !== null && ` · ${elapsed(reviewer.startedAt, reviewer.endedAt, now)}`}
            {` · ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      {reviewer.problem && <p className="problem">{reviewer.problem}</p>}
      {findings.length > 0 && (
        <section>
          <h3>Findings</h3>
          <ul className="finding-rows compact">
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} reviewer="" onOpen={() => openFinding(finding.id)} />
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
