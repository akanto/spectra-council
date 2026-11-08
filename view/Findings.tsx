/** Every finding, filterable by reviewer and severity, each opening to its summary, evidence and recommendation. */
import { useEffect, useRef, useState } from "react";
import { bySeverity } from "../core/describe.ts";
import { isFinished, isRulable, reportersOf, type Finding, type FindingStatus, type Review } from "../core/model.ts";
import { SEVERITIES, type Evidence, type Severity, type ViewAction } from "../core/schemas.ts";
import { ActionPlan, ProposalBlock, RulingControl } from "./Actions.tsx";
import { Markdown } from "./Markdown.tsx";
import { AlsoMark, AlsoReported, ConfidenceMeter, cx, FindingStatusBadge, FixBadge, Positions, RulingMark, SeverityBadge, TicketBadge } from "./ui.tsx";

const rulingOf = (review: Review, finding: Finding) => (!isRulable(review, finding) ? "n/a" : (finding.ruling?.decision ?? "unruled"));

const RULING_FILTERS = [["accepted", "Accepted"], ["dismissed", "Dismissed"], ["deferred", "Later"], ["unruled", "Not ruled"]] as const;

const where = (evidence: Evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}${evidence.endLine ? `-${evidence.endLine}` : ""}` : ""}`;

/** The original report, shared by both places where users rule on findings. */
export function FindingEvidence({ review, finding, openPath, select }: { review: Review; finding: Finding; openPath?: ((path: string) => void) | undefined; select?: (id: string) => void }) {
  return (
    <section aria-label="Original evidence and recommendation">
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
          <Markdown review={review} text={finding.recommendation} {...(select ? { select } : {})} {...(openPath ? { openPath } : {})} />
        </>
      )}
    </section>
  );
}

function FindingCard({ review, finding, reviewer, open, toggle, openInCouncil, openPath, act, busy, next }: { act(action: ViewAction): void; busy: boolean; next: { id: string; go(): void } | null; review: Review; finding: Finding; reviewer: string; open: boolean; toggle(): void; openInCouncil?: () => void; openPath?: (path: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <li ref={ref} className={cx("finding-card", open && "open")} id={`finding-${finding.id}`}>
      <button className="finding-row" onClick={toggle} aria-expanded={open}>
        <span className="finding-id mono">{finding.id}</span>
        <span className="finding-title">{finding.title}</span>
        <AlsoMark review={review} finding={finding} />
        <span className="finding-by muted">{reviewer}</span>
        <SeverityBadge severity={finding.severity} />
        <FindingStatusBadge status={finding.status} />
        <RulingMark finding={finding} />
        <FixBadge finding={finding} /> <TicketBadge finding={finding} />
      </button>
      {finding.positions.length > 0 && (
        <div className="finding-card-positions">
          <Positions review={review} finding={finding} />
        </div>
      )}
      {open && (
        <div className="finding-body">
          <RulingControl review={review} finding={finding} act={act} busy={busy} openPath={openPath} next={next} />
          <Markdown className="finding-summary" review={review} text={finding.summary} {...(openPath ? { openPath } : {})} />
          <p className="finding-state">
            <FindingStatusBadge status={finding.status} /> <RulingMark finding={finding} /> <FixBadge finding={finding} /> <TicketBadge finding={finding} />
            {openInCouncil && (
              <button className="link" onClick={openInCouncil}>
                Open in Council →
              </button>
            )}
          </p>
          {finding.fix?.summary && (
            <p className="muted">
              Fix: <Markdown inline review={review} text={finding.fix.summary} {...(openPath ? { openPath } : {})} />
              {finding.fix.files.length > 0 && ` (${finding.fix.files.join(", ")})`}
            </p>
          )}
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
          <AlsoReported review={review} finding={finding} />
          <FindingEvidence review={review} finding={finding} openPath={openPath} />
          <ProposalBlock review={review} finding={finding} openPath={openPath} />
          {finding.resolution && (
            <>
              <h4>Resolution</h4>
              <p>
                <FindingStatusBadge status={finding.resolution.status} /> <Markdown inline review={review} text={finding.resolution.rationale} />
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function Findings({ review, focus, select, act, busy, openInCouncil, openPath }: { select(id: string | null): void; act(action: ViewAction): void; busy: boolean; review: Review; focus: string | null; openInCouncil?: (id: string) => void; openPath?: (path: string) => void }) {
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [status, setStatus] = useState<FindingStatus | null>(null);
  const [ruling, setRuling] = useState<string | null>(null);
  const open = focus;
  const setOpen = select;
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const shown = [...review.findings].sort(bySeverity).filter((finding) => (!reviewer || reportersOf(finding).includes(reviewer)) && (!severity || finding.severity === severity) && (!status || finding.status === status) && (!ruling || rulingOf(review, finding) === ruling || finding.id === open));
  const reporters = review.reviewers.filter((each) => review.findings.some((finding) => reportersOf(finding).includes(each.id)));
  const count = (pick: (finding: Finding) => boolean) => review.findings.filter(pick).length;

  return (
    <div className="findings">
      {review.rounds === 0 && review.findings.some((finding) => isRulable(review, finding)) && <p className="hint">These reports have not been corroborated by council deliberation. Accept each finding individually.</p>}
      {review.rounds === 0 && <ActionPlan review={review} act={act} busy={busy} {...(openPath ? { openPath } : {})} />}
      <div className="filters">
        <div className="filter-group" role="group" aria-label="Reviewer">
          <button className={cx("chip", !reviewer && "chosen")} onClick={() => setReviewer(null)}>
            All reviewers
          </button>
          {reporters.map((each) => (
            <button key={each.id} className={cx("chip", reviewer === each.id && "chosen")} onClick={() => setReviewer(reviewer === each.id ? null : each.id)}>
              {each.label} <span className="muted">{count((finding) => reportersOf(finding).includes(each.id))}</span>
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
        <div className="filter-group" role="group" aria-label="Status">
          {(["agreed", "confirmed", "disputed", "reported", "withdrawn"] as const).filter((each) => count((finding) => finding.status === each) > 0).map((each) => (
            <button key={each} className={cx("chip", status === each && "chosen")} onClick={() => setStatus(status === each ? null : each)}>
              {each[0]!.toUpperCase() + each.slice(1)} <span className="muted">{count((finding) => finding.status === each)}</span>
            </button>
          ))}
        </div>
        {review.findings.some((finding) => finding.ruling) && (
          <div className="filter-group" role="group" aria-label="Ruling">
            {RULING_FILTERS.filter(([key]) => count((finding) => rulingOf(review, finding) === key) > 0).map(([key, word]) => (
              <button key={key} className={cx("chip", ruling === key && "chosen")} onClick={() => setRuling(ruling === key ? null : key)}>
                {word} <span className="muted">{count((finding) => rulingOf(review, finding) === key)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="empty-note">{review.findings.length === 0 ? (isFinished(review) ? "No findings were reported." : "No findings yet.") : "No findings match the filters."}</p>
      ) : (
        <ul className="finding-cards">
          {shown.map((finding) => (
            <FindingCard
              review={review}
              act={act}
              busy={busy}
              next={(() => {
                const at = shown.indexOf(finding);
                const next = [...shown.slice(at + 1), ...shown.slice(0, at)].find((each) => isRulable(review, each) && !each.ruling && !each.fix);
                return next ? { id: next.id, go: () => select(next.id) } : null;
              })()}
              key={finding.id}
              finding={finding}
              reviewer={label(finding.reviewerId)}
              open={open === finding.id}
              toggle={() => setOpen(open === finding.id ? null : finding.id)}
              {...(review.rounds > 0 && openInCouncil ? { openInCouncil: () => openInCouncil(finding.id) } : {})}
              {...(openPath ? { openPath } : {})}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
