/** The Council tab: the findings on the left, and the selected one's positions, resolution and argument timeline. */
import { useState } from "react";
import { bySeverity } from "../core/describe.ts";
import { argumentsOn, type Argument, type Finding, type Review } from "../core/model.ts";
import type { Evidence, ViewAction } from "../core/schemas.ts";
import { ActionPlan, ProposalBlock, RulingControl } from "./Actions.tsx";
import { ConfidenceMeter, cx, FindingStatusBadge, FixBadge, Positions, RulingMark, SeverityBadge, StanceBadge, VerdictBanner } from "./ui.tsx";

const where = (evidence: Evidence) => `${evidence.path}${evidence.line ? `:${evidence.line}${evidence.endLine ? `-${evidence.endLine}` : ""}` : ""}`;

function ArgumentItem({ review, argument, openPath }: { review: Review; argument: Argument; openPath?: (path: string) => void }) {
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
          answering {argument.replyTo}
          {parent ? ` (${label(parent.reviewerId)})` : ""}
        </div>
      )}
      <p>{argument.text}</p>
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

function FindingDetail({ review, finding, openPath, act, busy }: { review: Review; finding: Finding; openPath?: (path: string) => void; act(action: ViewAction): void; busy: boolean }) {
  const label = (id: string) => review.reviewers.find((each) => each.id === id)?.label ?? id;
  const timeline = argumentsOn(review, finding.id);
  const rounds = [...new Set(timeline.map((argument) => argument.round))].sort((a, b) => a - b);
  const seated = review.reviewers.filter((reviewer) => reviewer.enabled);
  const resolution = finding.resolution;
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
      </header>
      <p>{finding.summary}</p>

      <h3>Positions</h3>
      <ul className="position-grid">
        {seated.map((reviewer) => {
          const position = finding.positions.find((each) => each.reviewerId === reviewer.id);
          return (
            <li key={reviewer.id} className={cx("position-card", position ? `stance-${position.stance}` : "none")}>
              <strong>{reviewer.label}</strong>
              {position ? (
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
          <p>{resolution.rationale}</p>
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

      <RulingControl review={review} finding={finding} act={act} busy={busy} openPath={openPath} />

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
                  <ArgumentItem key={argument.id} review={review} argument={argument} {...(openPath ? { openPath } : {})} />
                ))}
            </ul>
          </section>
        ))
      )}
    </article>
  );
}

export function Deliberation({ review, focus, openPath, act, busy }: { review: Review; focus: string | null; openPath?: (path: string) => void; act(action: ViewAction): void; busy: boolean }) {
  const [picked, setPicked] = useState<string | null>(focus);
  const sorted = [...review.findings].sort((a, b) => Number(b.status === "disputed") - Number(a.status === "disputed") || bySeverity(a, b));
  const selected = review.findings.find((finding) => finding.id === picked) ?? sorted[0];
  return (
    <div className="council">
      <VerdictBanner review={review} />
      <ActionPlan review={review} act={act} busy={busy} {...(openPath ? { openPath } : {})} />
      {review.findings.length === 0 ? (
        <p className="empty-note">No findings to deliberate.</p>
      ) : (
        <div className="council-panes">
          <ul className="council-list">
            {sorted.map((finding) => (
              <li key={finding.id}>
                <button className={cx("council-item", finding.id === selected?.id && "chosen", finding.status === "disputed" && "disputed")} onClick={() => setPicked(finding.id)}>
                  <span className="council-item-top">
                    <span className="finding-id mono">{finding.id}</span>
                    <SeverityBadge severity={finding.severity} />
                    <FindingStatusBadge status={finding.status} />
                    <RulingMark finding={finding} />
                    <FixBadge finding={finding} />
                  </span>
                  <span className="council-item-title">{finding.title}</span>
                  <span className="council-item-foot">
                    <Positions review={review} finding={finding} />
                    <span className="muted">
                      {argumentsOn(review, finding.id).length} arg{argumentsOn(review, finding.id).length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && <FindingDetail review={review} finding={selected} act={act} busy={busy} {...(openPath ? { openPath } : {})} />}
        </div>
      )}
    </div>
  );
}
