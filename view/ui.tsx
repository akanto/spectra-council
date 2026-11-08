/** Small pieces the views share: status marks, badges, times, and the logo. */
import { createContext, useEffect, useState } from "react";
import { recheckLine, STATUS_MEANINGS } from "../core/describe.ts";
import type { Finding, FindingStatus, FixState, Phase, Review, ReviewerStatus } from "../core/model.ts";
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
  verifying: "Re-checking",
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
      case "verifying":
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
  verification: "Re-check",
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
    verification: "Re-checking fixes",
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
  return (
    <span className={`badge finding-${status}`} title={STATUS_MEANINGS[status]}>
      {FINDING_STATUS_WORDS[status]}
    </span>
  );
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

export const STANCE_GLYPHS: Record<Stance, string> = { supports: "✓", challenges: "✕", uncertain: "?" };

export function StanceBadge({ stance }: { stance: Stance }) {
  return (
    <span className={`badge stance-${stance}`}>
      <span aria-hidden="true">{STANCE_GLYPHS[stance]}</span> {STANCE_WORDS[stance]}
    </span>
  );
}

/** One chip per seated reviewer, showing its latest stance on a finding; faint when it has taken none, struck when it failed. */
export function Positions({ review, finding }: { review: Review; finding: Finding }) {
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  // Two letters when they tell the reviewers apart, else the initial and the reviewer's number.
  const short = seated.map((reviewer) => reviewer.label.slice(0, 2));
  const unique = new Set(short).size === short.length;
  return (
    <span className="positions" role="group" aria-label="Each reviewer's position on this finding">
      {seated.map((reviewer, index) => {
        const position = finding.positions.find((each) => each.reviewerId === reviewer.id);
        const failed = reviewer.status === "failed";
        const text = failed
          ? `${reviewer.label} failed and took no part`
          : position
            ? `${reviewer.label}: ${position.stance === "supports" ? "supports" : position.stance === "challenges" ? "challenges" : "is uncertain"}, ${position.confidence} confidence, ${position.round === 0 ? "reported it" : `round ${position.round}`}`
            : `${reviewer.label}: no position yet`;
        const tag = unique ? short[index] : `${reviewer.label.slice(0, 1)}${index + 1}`;
        return (
          <span key={reviewer.id} className={cx("position", failed ? "failed" : position ? `stance-${position.stance}` : "none")} role="img" aria-label={text} title={text}>
            <span className="position-glyph" aria-hidden="true">
              {failed ? "✕" : position ? STANCE_GLYPHS[position.stance] : ""}
            </span>
            <span aria-hidden="true">{tag}</span>
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
  const recheck = recheckLine(review);
  const statuses: FindingStatus[] = ["confirmed", "agreed", "disputed", "withdrawn"];
  return (
    <section className="verdict">
      <h3>Verdict</h3>
      <p>{review.verdict.summary}</p>
      {recheck && <p className="verdict-recheck">{recheck}</p>}
      <div className="verdict-counts">
        {statuses.map((status) => {
          const n = review.findings.filter((finding) => finding.status === status).length;
          return n > 0 && <span key={status}>{n} <FindingStatusBadge status={status} /></span>;
        })}
      </div>
    </section>
  );
}

const RULING_WORDS = { accepted: "Accepted", dismissed: "Dismissed", deferred: "Later" } as const;
const RULING_MARKS = { accepted: "✓", dismissed: "✕", deferred: "…" } as const;

/** A small mark of the user's ruling on a finding; nothing when it has none. */
export function RulingMark({ finding }: { finding: Finding }) {
  const decision = finding.ruling?.decision;
  if (!decision) return null;
  return (
    <span className={`ruling-mark ruling-${decision}`} title={`${RULING_WORDS[decision]}${finding.ruling?.note ? `: ${finding.ruling.note}` : ""}`}>
      {RULING_MARKS[decision]} {RULING_WORDS[decision]}
    </span>
  );
}

export const FIX_WORDS: Record<FixState, string> = { "handed-off": "Handed off", fixed: "Fixed", verified: "Verified", reopened: "Reopened" };

export function FixBadge({ finding }: { finding: Finding }) {
  if (!finding.fix) return null;
  return (
    <>
      <span className={`badge fix-${finding.fix.state}`}>{FIX_WORDS[finding.fix.state]}</span>
      {finding.fix.problem && (
        <span className="fix-problem-mark" title={`Not fixed: ${finding.fix.problem}`} aria-label="Needs attention">
          ⚠
        </span>
      )}
    </>
  );
}

/** The fixer profile this conversation chose (null: its own agent), supplied by App for the action plan. */
export const FixerContext = createContext<string | null>(null);

/** Where a merged-away finding id went: "F9" -> the finding that took its report in. */
export function mergedInto(review: Review): Map<string, string> {
  const map = new Map<string, string>();
  for (const finding of review.findings) for (const report of finding.alsoReported) map.set(report.findingId, finding.id);
  return map;
}

const reporterLabel = (review: Review, id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;

/** A small "+N" beside a finding that others reported too, with who in the tooltip. */
export function AlsoMark({ review, finding }: { review: Review; finding: Finding }) {
  const n = finding.alsoReported.length;
  if (n === 0) return null;
  const who = finding.alsoReported.map((report) => `${reporterLabel(review, report.reviewerId)} (${report.findingId}${report.mergedBy ? `, merged by ${reporterLabel(review, report.mergedBy)}` : ""})`).join(", ");
  return (
    <span className="also-mark" title={`Also reported by ${who}`} aria-label={`Also reported by ${who}`}>
      +{n}
    </span>
  );
}

/** "Also reported by Codex (F3, “title”), Gemini (F9)". */
export function AlsoReported({ review, finding }: { review: Review; finding: Finding }) {
  if (finding.alsoReported.length === 0) return null;
  return (
    <p className="also-reported">
      <span className="muted">Also reported by </span>
      {finding.alsoReported.map((report, index) => (
        <span key={`${report.reviewerId}:${report.findingId}`}>
          {index > 0 && ", "}
          <strong>{reporterLabel(review, report.reviewerId)}</strong> ({report.findingId}, “{report.title}”)
          {report.mergedBy && (
            <span className="muted">
              {" "}
              — merged by {reporterLabel(review, report.mergedBy)}
              {report.reason ? `: ${report.reason}` : ""}
            </span>
          )}
        </span>
      ))}
    </p>
  );
}
