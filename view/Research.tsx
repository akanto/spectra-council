/** A research council's views: the Answer tab, the Claims ledger, and the follow-up and ruling controls after the answer. */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { argumentsOn, claimReportersOf, isRunning, type Claim, type ClaimStatus, type Review, type SourceCheck } from "../core/model.ts";
import { answerPathOf } from "../core/research.ts";
import { ASK_MAX, type SourceOutcome, type ViewAction } from "../core/schemas.ts";
import { ArgumentItem } from "./Deliberation.tsx";
import { Markdown } from "./Markdown.tsx";
import { ConfidenceMeter, cx, Positions } from "./ui.tsx";

type Act = (action: ViewAction) => void;
type OpenPath = ((path: string) => void) | undefined;

const label = (review: Review, id: string) => review.reviewers.find((reviewer) => reviewer.id === id)?.label ?? id;

export const CLAIM_STATUS_WORDS: Record<ClaimStatus, string> = {
  reported: "Reported",
  confirmed: "Confirmed",
  disputed: "Disputed",
  agreed: "Agreed",
  withdrawn: "Withdrawn",
  unverified: "Unverified",
};

const CLAIM_STATUS_MEANINGS: Record<ClaimStatus, string> = {
  reported: "Not deliberated: nobody has weighed it.",
  confirmed: "Challenged, then backed once the challenges were answered.",
  agreed: "Everyone who weighed it backs it.",
  disputed: "A challenge still stands; the answer states it only with the dissent.",
  withdrawn: "Its reporter no longer backs it.",
  unverified: "A fact none of whose sources passed the check: it stays in the ledger and may appear only among the answer's leads.",
};

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return (
    <span className={`badge finding-${status}`} title={CLAIM_STATUS_MEANINGS[status]}>
      {CLAIM_STATUS_WORDS[status]}
    </span>
  );
}

/** "Struck" or "Kept" when the user ruled on the claim. */
export function ClaimRulingMark({ claim }: { claim: Claim }) {
  if (!claim.ruling) return null;
  const struck = claim.ruling.decision === "struck";
  return (
    <span className={cx("ruling-mark", struck ? "ruling-dismissed" : "ruling-accepted")} title={claim.ruling.note || undefined}>
      <span aria-hidden="true">{struck ? "✕" : "✓"}</span> {struck ? "Struck" : "Kept"}
    </span>
  );
}

const OUTCOME_WORDS: Record<SourceOutcome, string> = {
  verified: "verified",
  "quote-not-found": "quote not found",
  "doesnt-support": "doesn't support",
  unreachable: "unreachable",
  paywalled: "paywalled",
};

export function SourceOutcomeChip({ check, review }: { check: SourceCheck; review: Review }) {
  return (
    <span className={cx("source-check", `outcome-${check.outcome}`)} title={`${label(review, check.reviewerId)}: ${check.note}`}>
      <span aria-hidden="true">{check.outcome === "verified" ? "✓" : "✕"}</span> {OUTCOME_WORDS[check.outcome]} <span className="muted">· {label(review, check.reviewerId)}</span>
    </span>
  );
}

const verifiedSources = (claim: Claim) => claim.sources.filter((source) => source.checks.some((check) => check.outcome === "verified")).length;

const KIND_WORDS = { fact: "Fact", inference: "Inference", gap: "Gap" } as const;

/** A short tag for a claim of a follow-up run. */
const FollowUpMark = ({ claim }: { claim: Claim }) =>
  claim.pass > 0 ? (
    <span className="badge followup-mark" title={`Found by follow-up ${claim.pass}`}>
      follow-up {claim.pass}
    </span>
  ) : null;

/** A claim as one row: id, kind, title, reporters, status and your ruling. */
export function ClaimRow({ review, claim, onOpen, open, expanded }: { review: Review; claim: Claim; onOpen(): void; open?: boolean; expanded?: boolean }) {
  const reporters = claimReportersOf(claim);
  const checked = claim.sources.some((source) => source.checks.length > 0);
  return (
    <button className={cx("finding-row", "claim-row", claim.ruling?.decision === "struck" && "struck")} onClick={onOpen} {...(expanded !== undefined ? { "aria-expanded": expanded } : {})} {...(open ? { "aria-current": "true" as const } : {})}>
      <span className="finding-id mono">{claim.id}</span>
      <span className="finding-title">{claim.title}</span>
      <span className={cx("badge", "claim-kind", `claim-${claim.kind}`)}>{KIND_WORDS[claim.kind]}</span>
      {claim.rq && <span className="rq-mark mono">{claim.rq}</span>}
      <FollowUpMark claim={claim} />
      {claim.alsoReported.length > 0 && (
        <span className="also-mark" title={`Also reported by ${claim.alsoReported.map((report) => label(review, report.reviewerId)).join(", ")}`}>
          +{claim.alsoReported.length}
        </span>
      )}
      <span className="finding-by muted">{reporters.map((id) => label(review, id)).join(", ")}</span>
      {checked && claim.sources.length > 0 && (
        <span className="source-tally muted" title="Sources a checker verified">
          {verifiedSources(claim)}/{claim.sources.length} src
        </span>
      )}
      <ClaimStatusBadge status={claim.status} />
      <ClaimRulingMark claim={claim} />
    </button>
  );
}

/** Keep or strike a claim, with a note; open once the council has answered. */
function ClaimRulingControl({ review, claim, act, busy }: { review: Review; claim: Claim; act: Act; busy: boolean }) {
  const ruling = claim.ruling;
  const [note, setNote] = useState(ruling?.note ?? "");
  useEffect(() => {
    setNote(ruling?.note ?? "");
  }, [ruling?.note]);
  if (claim.status === "withdrawn") return null;
  const editable = review.phase === "complete";
  const rule = (decision: "kept" | "struck") => act({ kind: "rule-claim", claimId: claim.id, decision: ruling?.decision === decision ? null : decision, note: ruling?.decision === decision ? "" : note });
  return (
    <section className={cx("ruling", "ruling-top")}>
      <div className="ruling-row">
        <h3>{ruling ? "Your ruling" : "Keep or strike"}</h3>
        <div className="segmented" role="group" aria-label="Your ruling on this claim">
          {(["kept", "struck"] as const).map((decision) => (
            <button key={decision} className={cx("segment", decision === "kept" ? "segment-accepted" : "segment-dismissed", ruling?.decision === decision && "chosen")} aria-pressed={ruling?.decision === decision} disabled={!editable || busy} onClick={() => rule(decision)}>
              {decision === "kept" ? "Keep" : "Strike"}
            </button>
          ))}
        </div>
      </div>
      {ruling && (
        <div className="ruling-row">
          <input
            className="ruling-note"
            type="text"
            placeholder="Note (optional)"
            aria-label="Note on your ruling"
            value={note}
            disabled={!editable}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              if (note !== ruling.note) act({ kind: "rule-claim", claimId: claim.id, decision: ruling.decision, note });
            }}
          />
        </div>
      )}
      {!editable && !ruling && <p className="hint">You can keep or strike claims once the council has answered.</p>}
    </section>
  );
}

function ClaimBody({ review, claim, act, busy, select, openPath }: { review: Review; claim: Claim; act: Act; busy: boolean; select(id: string): void; openPath?: OpenPath }) {
  const timeline = argumentsOn(review, claim.id);
  const rounds = [...new Set(timeline.map((argument) => argument.round))].sort((a, b) => a - b);
  const resolution = claim.resolution;
  const dissent = resolution?.dissent ?? [];
  const fields = Object.entries(claim.fields);
  return (
    <div className="finding-body claim-body">
      <ClaimRulingControl review={review} claim={claim} act={act} busy={busy} />
      <Markdown className="finding-summary" review={review} text={claim.text} select={select} {...(openPath ? { openPath } : {})} />
      <dl className="finding-facts">
        <dt>Research question</dt>
        <dd>{claim.rq || "—"}</dd>
        <dt>Confidence</dt>
        <dd>
          <ConfidenceMeter confidence={claim.confidence} />
        </dd>
        <dt>Reported by</dt>
        <dd>
          {label(review, claim.reviewerId)}
          {claim.pass > 0 && <span className="muted"> · follow-up {claim.pass}</span>}
        </dd>
        {fields.map(([key, value]) => (
          <Fragment key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {claim.alsoReported.length > 0 && (
        <p className="also-reported">
          <span className="muted">Also reported by </span>
          {claim.alsoReported.map((report, index) => (
            <span key={`${report.reviewerId}:${report.claimId}`}>
              {index > 0 && ", "}
              <strong>{label(review, report.reviewerId)}</strong> ({report.claimId}, “{report.title}”)
            </span>
          ))}
        </p>
      )}

      {claim.positions.length > 0 && (
        <p className="claim-positions">
          <Positions review={review} finding={claim} />
        </p>
      )}

      {claim.sources.length > 0 && (
        <section aria-label="Sources">
          <h4>Sources</h4>
          <ol className="sources">
            {claim.sources.map((source, index) => (
              <li key={index} className="source">
                <div>
                  {/^https?:\/\//i.test(source.url) ? (
                    <a href={source.url} target="_blank" rel="noreferrer noopener">
                      {source.title}
                    </a>
                  ) : (
                    <span>{source.title}</span>
                  )}
                  <span className="muted">
                    {" "}
                    — {source.authors}, {source.venue}
                    {source.year ? `, ${source.year}` : ""}
                    {source.doi ? ` · doi:${source.doi}` : ""}
                  </span>
                </div>
                <pre className="quote">
                  {source.quote}
                  {source.locator ? `  (${source.locator})` : ""}
                </pre>
                <div className="source-checks">
                  <span className="badge read-depth" title="How much of the source the reporter read">
                    {source.read === "full-text" ? "full text" : source.read}
                  </span>
                  {source.checks.length === 0 ? <span className="muted">not checked</span> : source.checks.map((check, at) => <SourceOutcomeChip key={at} check={check} review={review} />)}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {resolution && (
        <div className={cx("resolution", resolution.status === "disputed" && "minority")}>
          <h4>
            {resolution.status === "disputed" ? "Minority report " : "Resolution "}
            <ClaimStatusBadge status={resolution.status} />
          </h4>
          <p>
            <Markdown inline review={review} text={resolution.rationale} select={select} />
          </p>
          {dissent.length > 0 && (
            <ul className="dissent">
              {dissent.map((each) => (
                <li key={each.reviewerId}>
                  <strong>{label(review, each.reviewerId)}</strong> still challenges it{each.reason ? ": " : "."}
                  {each.reason && <Markdown inline review={review} text={each.reason} select={select} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h4>Arguments {timeline.length > 0 && <span className="muted">{timeline.length}</span>}</h4>
      {timeline.length === 0 ? (
        <p className="empty-note">{isRunning(review) && review.phase === "deliberation" ? "Nobody has argued this one yet." : "No arguments were made on this claim."}</p>
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
    </div>
  );
}

const STATUS_ORDER: ClaimStatus[] = ["agreed", "confirmed", "disputed", "unverified", "reported", "withdrawn"];

type StatusFilter = ClaimStatus | "struck";

/** Orders research questions as a person reads them: "RQ2" before "RQ10", no question last. */
const byRq = (a: string, b: string) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true }));
const byId = (a: Claim, b: Claim) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function ClaimCard({ review, claim, open, toggle, act, busy, select, openPath }: { review: Review; claim: Claim; open: boolean; toggle(): void; act: Act; busy: boolean; select(id: string): void; openPath?: OpenPath }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <li ref={ref} className={cx("finding-card", "claim-card", open && "open")} id={`claim-${claim.id}`}>
      <ClaimRow review={review} claim={claim} onOpen={toggle} expanded={open} />
      {open && <ClaimBody review={review} claim={claim} act={act} busy={busy} select={select} {...(openPath ? { openPath } : {})} />}
    </li>
  );
}

/** The claim ledger, grouped by the brief's research question and filterable by status. */
export function ClaimsTab({ review, focus, select, act, busy, openPath }: { review: Review; focus: string | null; select(id: string | null): void; act: Act; busy: boolean; openPath?: OpenPath }) {
  const [status, setStatus] = useState<StatusFilter | null>(null);
  const claims = review.research?.claims ?? [];
  const isStruck = (claim: Claim) => claim.ruling?.decision === "struck";
  const count = (pick: (claim: Claim) => boolean) => claims.filter(pick).length;
  const shown = claims.filter((claim) => status === null || claim.id === focus || (status === "struck" ? isStruck(claim) : claim.status === status));
  const groups = [...new Set(shown.map((claim) => claim.rq))].sort(byRq);
  return (
    <div className="findings claims">
      {claims.length > 0 && (
        <div className="filters">
          <div className="filter-group" role="group" aria-label="Status">
            {STATUS_ORDER.filter((each) => count((claim) => claim.status === each) > 0).map((each) => (
              <button key={each} className={cx("chip", status === each && "chosen")} onClick={() => setStatus(status === each ? null : each)}>
                {CLAIM_STATUS_WORDS[each]} <span className="muted">{count((claim) => claim.status === each)}</span>
              </button>
            ))}
            {count(isStruck) > 0 && (
              <button className={cx("chip", status === "struck" && "chosen")} onClick={() => setStatus(status === "struck" ? null : "struck")}>
                Struck <span className="muted">{count(isStruck)}</span>
              </button>
            )}
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="empty-note">{claims.length === 0 ? (isRunning(review) ? "No claims yet. They appear here as the seats report them." : "No claims were reported.") : "No claims match the filter."}</p>
      ) : (
        groups.map((rq) => (
          <section key={rq || "none"} className="claim-group">
            <h3>{rq ? `${rq}` : "No research question"}</h3>
            <ul className="finding-cards">
              {shown
                .filter((claim) => claim.rq === rq)
                .sort(byId)
                .map((claim) => (
                  <ClaimCard key={claim.id} review={review} claim={claim} open={focus === claim.id} toggle={() => select(focus === claim.id ? null : claim.id)} act={act} busy={busy} select={select} {...(openPath ? { openPath } : {})} />
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// The answer's Markdown: the shared renderer's paragraphs, lists and code, plus the headings, tables and rules an answer has.
type AnswerBlock = { kind: "md"; text: string } | { kind: "heading"; level: number; text: string } | { kind: "table"; header: string[]; rows: string[][] } | { kind: "rule" };

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let chunk: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (chunk.some((line) => line.trim() !== "")) blocks.push({ kind: "md", text: chunk.join("\n") });
    chunk = [];
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      chunk.push(line);
      if (mark && mark[1]!.startsWith(fence) && line.trim().replace(/^[`~]+/, "") === "") fence = null;
      continue;
    }
    if (mark) {
      fence = mark[1]![0]!.repeat(3);
      chunk.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.trim().startsWith("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim() !== "") rows.push(cells(lines[index++]!));
      index--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    chunk.push(line);
  }
  flush();
  return blocks;
}

/** The answer's Markdown; `[C3]` citations are buttons that open the claim. */
export function AnswerMarkdown({ review, text, select, openPath }: { review: Review; text: string; select(id: string): void; openPath?: OpenPath }) {
  const common = { review, select, ...(openPath ? { openPath } : {}) };
  return (
    <div className="answer-text">
      {answerBlocks(text).map((block, index): ReactNode => {
        if (block.kind === "md") return <Markdown key={index} text={block.text} {...common} />;
        if (block.kind === "rule") return <hr key={index} />;
        if (block.kind === "heading") {
          const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
          return (
            <Tag key={index} className="answer-heading">
              <Markdown inline text={block.text} {...common} />
            </Tag>
          );
        }
        return (
          <div key={index} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.header.map((cell, at) => (
                    <th key={at}>
                      <Markdown inline text={cell} {...common} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, at) => (
                  <tr key={at}>
                    {block.header.map((_, column) => (
                      <td key={column}>
                        <Markdown inline text={row[column] ?? ""} {...common} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

/** The follow-up box: a question the council researches, adding claims and revising the same answer. */
function FollowUpBox({ review, act, busy }: { review: Review; act: Act; busy: boolean }) {
  const [text, setText] = useState("");
  const research = review.research!;
  const waiting = research.followUps.some((followUp) => followUp.startedAt === null);
  const editable = review.phase === "complete";
  const send = () => {
    const question = text.trim();
    if (!question) return;
    act({ kind: "follow-up", text: question });
    setText("");
  };
  return (
    <section className="followup-box" aria-label="Follow up">
      <h3>Follow up</h3>
      <textarea
        rows={3}
        value={text}
        maxLength={ASK_MAX}
        disabled={!editable}
        placeholder="Send the council back with a question, for example: RQ2 came back thin; look at RSNA informatics 2018 to 2025."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
        }}
      />
      <div className="followup-send">
        <button className="primary" disabled={!editable || busy || text.trim() === ""} onClick={send}>
          {waiting ? "Replace the waiting follow-up" : "Send follow-up"}
        </button>
        {!editable && <span className="hint">You can follow up once the council has answered.</span>}
      </div>
      {research.followUps.length > 0 && (
        <ol className="followups">
          {research.followUps.map((followUp, index) => {
            const found = research.claims.filter((claim) => claim.pass === followUp.pass).length;
            const running = followUp.startedAt !== null && research.pass === followUp.pass && isRunning(review);
            return (
              <li key={index}>
                <span className="muted">Follow-up {followUp.pass}: </span>
                {followUp.question}{" "}
                <span className="muted">
                  {followUp.startedAt === null ? "· waiting for the agent to start it" : running ? "· researching" : `· ${found} new claim${found === 1 ? "" : "s"}`}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The Answer tab: the editor's latest draft, the council's objections to it, and what follows an answer. */
export function AnswerTab({ review, act, busy, select, openPath }: { review: Review; act: Act; busy: boolean; select(id: string): void; openPath?: OpenPath }) {
  const research = review.research!;
  const latest = research.drafts[research.drafts.length - 1];
  const path = research.written?.path ?? answerPathOf(review);
  const struck = research.claims.filter((claim) => claim.ruling?.decision === "struck").length;
  // The objections of each run's drafts, newest first: the first draft's, and any left after the revision.
  const objections = research.objections.filter((objection) => objection.pass === latest?.pass);
  const revisions = [...new Set(objections.map((objection) => objection.revision))].sort((a, b) => a - b);
  const busyWriting = isRunning(review) && review.phase === "synthesis";
  return (
    <div className="answer">
      <header className="answer-head">
        <h2>Answer</h2>
        {path && (
          <span className="answer-path">
            {research.written ? "Written to " : "Will be written to "}
            {openPath && research.written ? (
              <button className="link mono" onClick={() => openPath(path)}>
                {path}
              </button>
            ) : (
              <span className="mono">{path}</span>
            )}
          </span>
        )}
      </header>
      {review.verdict && <p className="muted answer-verdict">{review.verdict.summary}</p>}

      {research.revisionDue && review.phase === "complete" && (
        <div className="revise-banner" role="status">
          <span>
            You kept or struck claims since this draft{struck > 0 ? ` (${struck} struck)` : ""}. The editor can revise the answer to match.
          </span>
          <button className="primary" disabled={busy} onClick={() => act({ kind: "revise" })}>
            Revise answer
          </button>
        </div>
      )}

      {latest && latest.problems.length > 0 && (
        <div className="problem answer-problems" role="alert">
          <div>
            <strong>The plugin found problems with this draft:</strong>
            <ul>
              {latest.problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {revisions.map((revision) => {
        const these = objections.filter((objection) => objection.revision === revision);
        const answered = latest !== undefined && latest.revision > revision;
        return (
          <section key={revision} className="objections" aria-label="Objections">
            <h4>
              Council's objections to the {revision === 0 ? "first draft" : `revision ${revision}`} <span className="muted">{answered ? "· the editor revised" : "· still open"}</span>
            </h4>
            <ul>
              {these.map((objection) => (
                <li key={objection.id}>
                  <strong>{label(review, objection.reviewerId)}</strong>
                  {objection.claimId && (
                    <>
                      {" on "}
                      <button className="link finding-ref" onClick={() => select(objection.claimId!)}>
                        {objection.claimId}
                      </button>
                    </>
                  )}
                  : “{objection.excerpt}” — {objection.problem}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {latest ? (
        <article className="answer-body" aria-label="The answer">
          <AnswerMarkdown review={review} text={latest.markdown} select={select} {...(openPath ? { openPath } : {})} />
        </article>
      ) : (
        <p className="empty-note">{busyWriting ? "The editor is drafting the answer…" : "No answer was written."}</p>
      )}

      {review.phase === "complete" || research.followUps.length > 0 ? <FollowUpBox review={review} act={act} busy={busy} /> : null}
    </div>
  );
}
