/** Small pieces the views share: status marks, badges, times, and the logo. */
import { useEffect, useState } from "react";
import type { Finding, FindingStatus, Phase, Review, ReviewerStatus } from "../core/model.ts";
import { STANCE_VERBS } from "../core/review.ts";
import type { Confidence, Severity, Stance } from "../core/schemas.ts";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.2 6.3M20.5 12a8.5 8.5 0 0 1-6.3 8.2M12 20.5a8.5 8.5 0 0 1-8.2-6.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="19.6" cy="6.2" r="1.6" fill="currentColor" />
      <circle cx="4.4" cy="17.8" r="1.6" fill="currentColor" />
    </svg>
  );
}

const STATUS_WORDS: Record<ReviewerStatus, string> = {
  idle: "Not seated",
  waiting: "Waiting",
  reviewing: "Reviewing",
  deliberating: "Deliberating",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function StatusMark({ status }: { status: ReviewerStatus }) {
  const label = STATUS_WORDS[status];
  const body = (() => {
    switch (status) {
      case "reviewing":
      case "deliberating":
        return (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle className="pulse" cx="8" cy="8" r="3.4" fill="currentColor" />
          </>
        );
      case "completed":
        return (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5.2 8.3l1.9 1.9 3.8-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </>
        );
      case "failed":
        return (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </>
        );
      case "stopped":
        return (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="0.8" fill="currentColor" />
          </>
        );
      default:
        return <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={status === "waiting" ? "2.4 2.2" : undefined} />;
    }
  })();
  return (
    <svg className={`status-mark status-${status}`} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      {body}
    </svg>
  );
}

export const statusWord = (status: ReviewerStatus) => STATUS_WORDS[status];

export const PHASE_WORDS: Record<Phase, string> = {
  setup: "Setup",
  "independent-review": "Independent review",
  deliberation: "Deliberation",
  synthesis: "Synthesis",
  complete: "Complete",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

export function PhasePill({ phase }: { phase: Phase }) {
  const words: Record<Phase, string> = {
    setup: "Setting up",
    "independent-review": "Review running",
    deliberation: "Deliberating",
    synthesis: "Synthesising",
    complete: "Review complete",
    stopped: "Stopped",
    interrupted: "Interrupted",
  };
  return (
    <span className={`pill phase-${phase}`}>
      <span className="pill-dot" />
      {words[phase]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge severity-${severity}`}>{severity}</span>;
}

const FINDING_STATUS_WORDS: Record<FindingStatus, string> = {
  reported: "Reported",
  confirmed: "Confirmed",
  disputed: "Disputed",
  agreed: "Agreed",
  withdrawn: "Withdrawn",
};

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <span className={`badge finding-${status}`}>{FINDING_STATUS_WORDS[status]}</span>;
}

export function ConfidenceMeter({ confidence }: { confidence: Confidence }) {
  const filled = { low: 1, medium: 2, high: 3 }[confidence];
  return (
    <span className="confidence" title={`${confidence} confidence`}>
      {[1, 2, 3].map((bar) => (
        <span key={bar} className={cx("confidence-bar", bar <= filled && "on")} />
      ))}
      <span className="confidence-word">{confidence}</span>
    </span>
  );
}

/** "0:42", "12:05", "1:02:03". */
export function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The time now, again every second while `ticking`. */
export function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** A span of time from start to end, or to now while it runs. */
export const elapsed = (start: number | null, end: number | null, now: number) => (start === null ? null : duration((end ?? now) - start));

const STANCE_WORDS: Record<Stance, string> = { supports: "Supports", challenges: "Challenges", uncertain: "Uncertain" };

export function StanceBadge({ stance }: { stance: Stance }) {
  return <span className={`badge stance-${stance}`}>{STANCE_WORDS[stance]}</span>;
}

/** One chip per seated reviewer, showing its latest stance on a finding; faint when it has taken none. */
export function Positions({ review, finding }: { review: Review; finding: Finding }) {
  return (
    <span className="positions" aria-label="Positions">
      {review.reviewers
        .filter((reviewer) => reviewer.enabled)
        .map((reviewer) => {
          const position = finding.positions.find((each) => each.reviewerId === reviewer.id);
          const title = position ? `${reviewer.label}: ${STANCE_VERBS[position.stance]} (${position.confidence}, round ${position.round})` : `${reviewer.label}: no position yet`;
          return (
            <span key={reviewer.id} className={cx("position", position ? `stance-${position.stance}` : "none")} title={title}>
              <span className="position-dot" />
              {reviewer.label.slice(0, 2)}
            </span>
          );
        })}
    </span>
  );
}

/** The verdict once set; while the synthesis runs, its progress. */
export function VerdictBanner({ review }: { review: Review }) {
  if (review.phase === "synthesis" && !review.verdict) {
    const resolved = review.findings.filter((finding) => finding.resolution !== null).length;
    return (
      <div className="verdict settling" role="status">
        <strong>Settling the findings…</strong>
        <span className="muted">
          {resolved} of {review.findings.length} resolved
        </span>
      </div>
    );
  }
  if (!review.verdict) return null;
  const statuses: FindingStatus[] = ["confirmed", "agreed", "disputed", "withdrawn"];
  return (
    <section className="verdict">
      <h3>Verdict</h3>
      <p>{review.verdict.summary}</p>
      <div className="verdict-counts">
        {statuses.map((status) => {
          const n = review.findings.filter((finding) => finding.status === status).length;
          return n > 0 && <span key={status}>{n} <FindingStatusBadge status={status} /></span>;
        })}
      </div>
    </section>
  );
}
