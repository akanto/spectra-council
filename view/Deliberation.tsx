/** The Council tab: the findings on the left, and the selected one's positions, resolution and argument timeline. */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { bySeverity, possibleDuplicates, STATUS_MEANINGS } from "../core/describe.ts";
import { argumentsOn, isStanding, type Argument, type Finding, type Review } from "../core/model.ts";
import type { FindingStatus } from "../core/model.ts";
import type { Evidence, ViewAction } from "../core/schemas.ts";
import { ActionPlan, ProposalBlock, RulingControl } from "./Actions.tsx";
import { AlsoMark, AlsoReported, ConfidenceMeter, cx, mergedInto, FindingStatusBadge, FixBadge, Positions, RulingMark, SeverityBadge, StanceBadge, VerdictBanner } from "./ui.tsx";

const where = (evidence: Evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}${evidence.endLine ? `-${evidence.endLine}` : ""}` : ""}`;

/** Text in which finding ids like "F6" that exist in the review become buttons selecting that finding. */
function LinkedText({ review, text, select }: { review: Review; text: string; select(id: string): void }) {
  const parts: ReactNode[] = [];
  const merged = mergedInto(review);
  text.split(/(\bF\d+\b)/).forEach((part, index) => {
    const target = index % 2 === 1 ? (review.findings.some((finding) => finding.id === part) ? part : merged.get(part)) : undefined;
    if (target) {
      parts.push(
        <button key={index} className="link finding-ref" title={target === part ? undefined : `${part} was merged into ${target}`} onClick={() => select(target)}>
          {part}
        </button>,
      );
    } else parts.push(<Fragment key={index}>{part}</Fragment>);
  });
  return <>{parts}</>;
}

/** Scroll to an argument and flash it, so "answering A42" shows what it answers. */
function jumpToArgument(id: string) {
  const element = document.getElementById(`argument-${id}`);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.remove("flash");
  void element.offsetWidth;
  element.classList.add("flash");
  setTimeout(() => element.classList.remove("flash"), 1800);
}

function ArgumentItem({ review, argument, openPath, select }: { review: Review; argument: Argument; openPath?: (path: string) => void; select(id: string): void }) {
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const parent = argument.replyTo ? review.arguments.find((each) => each.id === argument.replyTo) : undefined;
  return (
    <li className="argument" id={`argument-${argument.id}`}>
      <div className="argument-head">
        <strong>{label(argument.reviewerId)}</strong>
        <StanceBadge stance={argument.stance} />
        <ConfidenceMeter confidence={argument.confidence} />
        <span className="mono muted argument-id">{argument.id}</span>
      </div>
      {argument.replyTo && (
        <div className="muted argument-reply">
          answering{" "}
          {parent ? (
            <button className="link mono" onClick={() => jumpToArgument(argument.replyTo!)}>
              {argument.replyTo}
            </button>
          ) : (
            argument.replyTo
          )}
          {parent ? ` (${label(parent.reviewerId)})` : ""}
        </div>
      )}
      <p>
        <LinkedText review={review} text={argument.text} select={select} />
      </p>
      {argument.evidence.length > 0 && (
        <ul className="evidence">
          {argument.evidence.map((evidence, index) => (
            <li key={index}>
              {openPath ? (
                <button className="link mono" onClick={() => openPath(evidence.path)}>
                  {where(evidence)}
                </button>
              ) : (
                <span className="mono">{where(evidence)}</span>
              )}
              {evidence.note && <span className="muted"> — {evidence.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FindingDetail({ review, finding, openPath, act, busy, select, next }: { review: Review; finding: Finding; openPath?: (path: string) => void; act(action: ViewAction): void; busy: boolean; select(id: string): void; next: { id: string; go(): void } | null }) {
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const timeline = argumentsOn(review, finding.id);
  const rounds = [...new Set(timeline.map((argument) => argument.round))].sort((a, b) => a - b);
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  const resolution = finding.resolution;
  const duplicates = possibleDuplicates(review, finding);
  return (
    <article className="council-detail">
      <header>
        <div className="council-detail-title">
          <span className="finding-id mono">{finding.id}</span>
          <h2>{finding.title}</h2>
        </div>
        <div className="council-detail-meta">
          <SeverityBadge severity={finding.severity} />
          <FindingStatusBadge status={finding.status} />
          <span className="muted">reported by {label(finding.reviewerId)}</span>
        </div>
        <AlsoReported review={review} finding={finding} />
        {duplicates.length > 0 && (
          <p className="duplicates muted">
            Possibly the same as{" "}
            {duplicates.map((other, index) => (
              <Fragment key={other.id}>
                {index > 0 && ", "}
                <button className="link" title={other.title} onClick={() => select(other.id)}>
                  {other.id}
                </button>
              </Fragment>
            ))}
          </p>
        )}
      </header>

      <RulingControl review={review} finding={finding} act={act} busy={busy} openPath={openPath} next={next} />

      <p>{finding.summary}</p>

      <h3>Positions</h3>
      <ul className="position-grid">
        {seated.map((reviewer) => {
          const position = finding.positions.find((each) => each.reviewerId === reviewer.id);
          const failed = reviewer.status === "failed";
          return (
            <li key={reviewer.id} className={cx("position-card", failed ? "failed" : position ? `stance-${position.stance}` : "none")} title={failed ? `${reviewer.label} failed and took no part` : undefined}>
              <strong>{failed && <span aria-hidden="true">✕ </span>}{reviewer.label}</strong>
              {failed ? (
                <span className="muted">failed, took no part</span>
              ) : position ? (
                <>
                  <StanceBadge stance={position.stance} />
                  <ConfidenceMeter confidence={position.confidence} />
                  <span className="muted">{position.round === 0 ? "reported it" : `round ${position.round}`}</span>
                </>
              ) : (
                <span className="muted">no position yet</span>
              )}
            </li>
          );
        })}
      </ul>

      {resolution && resolution.status !== "disputed" && (
        <div className="resolution">
          <h4>
            Resolution <FindingStatusBadge status={resolution.status} />
          </h4>
          <p>
            <LinkedText review={review} text={resolution.rationale} select={select} />
          </p>
        </div>
      )}

      <ProposalBlock review={review} finding={finding} openPath={openPath} />

      {resolution && resolution.status === "disputed" && (
        <div className="resolution minority">
          <h4>Minority report</h4>
          <p>
            {resolution.dissenters.map(label).join(", ") || "A reviewer"} still challenge{resolution.dissenters.length === 1 ? "s" : ""} this finding.
          </p>
          <p>{resolution.rationale}</p>
        </div>
      )}

      <h3>Arguments {timeline.length > 0 && <span className="muted">{timeline.length}</span>}</h3>
      {timeline.length === 0 ? (
        <p className="empty-note">{review.phase === "deliberation" ? "Nobody has argued this one yet." : "No arguments were made on this finding."}</p>
      ) : (
        rounds.map((round) => (
          <section key={round} className="argument-round">
            <h4>Round {round}</h4>
            <ul className="arguments">
              {timeline
                .filter((argument) => argument.round === round)
                .map((argument) => (
                  <ArgumentItem key={argument.id} review={review} argument={argument} select={select} {...(openPath ? { openPath } : {})} />
                ))}
            </ul>
          </section>
        ))
      )}
    </article>
  );
}

function StatusLegend() {
  const statuses: FindingStatus[] = ["agreed", "confirmed", "disputed", "reported", "withdrawn"];
  return (
    <details className="status-legend">
      <summary>What do the statuses mean?</summary>
      <dl>
        {statuses.map((status) => (
          <Fragment key={status}>
            <dt>
              <FindingStatusBadge status={status} />
            </dt>
            <dd>{STATUS_MEANINGS[status]}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

export function Deliberation({ review, focus, openPath, act, busy }: { review: Review; focus: string | null; openPath?: (path: string) => void; act(action: ViewAction): void; busy: boolean }) {
  const [picked, setPicked] = useState<string | null>(focus);
  useEffect(() => {
    if (focus) setPicked(focus);
  }, [focus]);
  const detailRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const sorted = [...review.findings].sort((a, b) => Number(b.status === "disputed") - Number(a.status === "disputed") || bySeverity(a, b));
  const mergedTo = mergedInto(review);
  const selected = review.findings.find((finding) => finding.id === picked) ?? review.findings.find((finding) => finding.id === mergedTo.get(picked ?? "")) ?? sorted[0];
  const selectedId = selected?.id;
  // In the single-column layout the detail sits below the list: bring it into view when the selection changes.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (window.matchMedia("(max-width: 720px)").matches) detailRef.current?.scrollIntoView({ block: "start" });
  }, [selectedId]);
  const needsRuling = (finding: Finding) => review.phase === "complete" && isStanding(finding) && !finding.ruling && !finding.fix;
  // The next finding that still needs a ruling, down the list and wrapping round, for the ruling control to offer.
  const nextToRule = (() => {
    if (!selected) return null;
    const at = sorted.findIndex((finding) => finding.id === selected.id);
    const found = [...sorted.slice(at + 1), ...sorted.slice(0, at)].find(needsRuling);
    return found ? { id: found.id, go: () => setPicked(found.id) } : null;
  })();
  return (
    <div className="council">
      <VerdictBanner review={review} />
      <ActionPlan review={review} act={act} busy={busy} {...(openPath ? { openPath } : {})} />
      {review.findings.length > 0 && <StatusLegend />}
      {review.findings.length === 0 ? (
        <p className="empty-note">No findings to deliberate.</p>
      ) : (
        <div className="council-panes">
          <ul className="council-list">
            {sorted.map((finding) => {
              const twins = possibleDuplicates(review, finding);
              return (
                <li key={finding.id}>
                  <button className={cx("council-item", finding.id === selected?.id && "chosen", finding.status === "disputed" && "disputed")} aria-current={finding.id === selected?.id ? "true" : undefined} onClick={() => setPicked(finding.id)}>
                    <span className="council-item-top">
                      <span className="finding-id mono">{finding.id}</span>
                      {twins.length > 0 && (
                        <span className="dup-mark" title={`Possibly the same as ${twins.map((other) => other.id).join(", ")}`} aria-label={`Possibly the same as ${twins.map((other) => other.id).join(", ")}`}>
                          ≈
                        </span>
                      )}
                      <SeverityBadge severity={finding.severity} />
                      <FindingStatusBadge status={finding.status} />
                      {needsRuling(finding) && (
                        <span className="needs-ruling-dot" title="Needs your ruling" role="img" aria-label="Needs your ruling">
                          ○
                        </span>
                      )}
                      <RulingMark finding={finding} />
                      <FixBadge finding={finding} />
                    </span>
                    <span className="council-item-title">
                      {finding.title} <AlsoMark review={review} finding={finding} />
                    </span>
                    <span className="council-item-foot">
                      <Positions review={review} finding={finding} />
                      <span className="muted">
                        {argumentsOn(review, finding.id).length} arg{argumentsOn(review, finding.id).length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div ref={detailRef} className="council-detail-wrap">
            {selected && <FindingDetail key={selected.id} review={review} finding={selected} act={act} busy={busy} select={setPicked} next={nextToRule} {...(openPath ? { openPath } : {})} />}
          </div>
        </div>
      )}
    </div>
  );
}
