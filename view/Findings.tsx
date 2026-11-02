/** Every finding, filterable by reviewer and severity, each opening to its summary, evidence and recommendation. */
import { useEffect, useRef, useState } from "react";
import { bySeverity } from "../core/describe.ts";
import type { Finding, Review } from "../core/model.ts";
import { SEVERITIES, type Evidence, type Severity } from "../core/schemas.ts";
import { ConfidenceMeter, cx, FindingStatusBadge, SeverityBadge } from "./ui.tsx";

const where = (evidence: Evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}${evidence.endLine ? `-${evidence.endLine}` : ""}` : ""}`;

function FindingCard({ finding, reviewer, open, toggle, openPath }: { finding: Finding; reviewer: string; open: boolean; toggle(): void; openPath?: (path: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <li ref={ref} className={cx("finding-card", open && "open")} id={`finding-${finding.id}`}>
      <button className="finding-row" onClick={toggle} aria-expanded={open}>
        <span className="finding-id mono">{finding.id}</span>
        <span className="finding-title">{finding.title}</span>
        <span className="finding-by muted">{reviewer}</span>
        <SeverityBadge severity={finding.severity} />
        <FindingStatusBadge status={finding.status} />
      </button>
      {open && (
        <div className="finding-body">
          <p>{finding.summary}</p>
          <dl className="finding-facts">
            <dt>Category</dt>
            <dd>{finding.category}</dd>
            <dt>Confidence</dt>
            <dd>
              <ConfidenceMeter confidence={finding.confidence} />
            </dd>
            <dt>Reported by</dt>
            <dd>{reviewer}</dd>
          </dl>
          <h4>Evidence</h4>
          <ul className="evidence">
            {finding.evidence.map((evidence, index) => (
              <li key={index}>
                {openPath ? (
                  <button className="link mono" onClick={() => openPath(evidence.path)}>
                    {where(evidence)}
                  </button>
                ) : (
                  <span className="mono">{where(evidence)}</span>
                )}
                {evidence.note && <span className="muted"> — {evidence.note}</span>}
                {evidence.quote && <pre className="quote">{evidence.quote}</pre>}
              </li>
            ))}
          </ul>
          {finding.recommendation && (
            <>
              <h4>Recommendation</h4>
              <p>{finding.recommendation}</p>
            </>
          )}
          <p className="hint">Deliberation (support, challenges, verdict) comes with the council's rounds.</p>
        </div>
      )}
    </li>
  );
}

export function Findings({ review, focus, openPath }: { review: Review; focus: string | null; openPath?: (path: string) => void }) {
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [open, setOpen] = useState<string | null>(focus);
  useEffect(() => {
    setOpen(focus);
  }, [focus]);
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const shown = [...review.findings].sort(bySeverity).filter((finding) => (!reviewer || finding.reviewerId === reviewer) && (!severity || finding.severity === severity));
  const reporters = review.reviewers.filter((each) => review.findings.some((finding) => finding.reviewerId === each.id));
  const count = (pick: (finding: Finding) => boolean) => review.findings.filter(pick).length;

  return (
    <div className="findings">
      <div className="filters">
        <div className="filter-group" role="group" aria-label="Reviewer">
          <button className={cx("chip", !reviewer && "chosen")} onClick={() => setReviewer(null)}>
            All reviewers
          </button>
          {reporters.map((each) => (
            <button key={each.id} className={cx("chip", reviewer === each.id && "chosen")} onClick={() => setReviewer(reviewer === each.id ? null : each.id)}>
              {each.label} <span className="muted">{count((finding) => finding.reviewerId === each.id)}</span>
            </button>
          ))}
        </div>
        <div className="filter-group" role="group" aria-label="Severity">
          {SEVERITIES.filter((each) => count((finding) => finding.severity === each) > 0).map((each) => (
            <button key={each} className={cx("chip", `chip-${each}`, severity === each && "chosen")} onClick={() => setSeverity(severity === each ? null : each)}>
              {each} <span className="muted">{count((finding) => finding.severity === each)}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="empty-note">{review.findings.length === 0 ? "No findings yet." : "No findings match the filters."}</p>
      ) : (
        <ul className="finding-cards">
          {shown.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              reviewer={label(finding.reviewerId)}
              open={open === finding.id}
              toggle={() => setOpen(open === finding.id ? null : finding.id)}
              {...(openPath ? { openPath } : {})}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
