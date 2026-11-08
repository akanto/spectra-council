/** The Spectra Council view: setup, then the live workspace and the findings, around one review the host hands in. */
import { useCallback, useEffect, useRef, useState } from "react";
import { isFinished, isRunning, seatedReviewers, type Review } from "../core/model.ts";
import { DEPTH_TITLES } from "../core/depth.ts";
import { PROFILES } from "../core/profiles.ts";
import type { SetupPatch, ViewAction } from "../core/schemas.ts";
import type { CouncilBridge } from "./bridge.ts";
import { Deliberation } from "./Deliberation.tsx";
import { Findings } from "./Findings.tsx";
import { ReviewerDetail } from "./ReviewerDetail.tsx";
import { Setup } from "./Setup.tsx";
import { cx, elapsed, FixerContext, Logo, PHASE_WORDS, PhasePill, useNow } from "./ui.tsx";
import { Workspace } from "./Workspace.tsx";

type Tab = "workspace" | "council" | "findings";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sends actions one after another, so a setup change always lands before the start that follows it. */
function useSender(bridge: CouncilBridge, onError: (message: string | null) => void) {
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [busy, setBusy] = useState(0);
  const send = useCallback(
    (action: ViewAction) => {
      setBusy((count) => count + 1);
      const sent = queue.current.then(() => bridge.send(action));
      queue.current = sent.catch(() => {});
      sent.then(
        () => onError(null),
        (error) => onError(messageOf(error)),
      ).finally(() => setBusy((count) => count - 1));
      return sent;
    },
    [bridge, onError],
  );
  return { send, busy: busy > 0 };
}

export function App({ bridge }: { bridge: CouncilBridge }) {
  const [review, setReview] = useState<Review | null>(null);
  const [tab, setTab] = useState<Tab>("workspace");
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const reviewerOpen = useRef(false);
  reviewerOpen.current = reviewerId !== null;
  const { send, busy } = useSender(bridge, setProblem);
  const [confirmStop, setConfirmStop] = useState(false);
  const [fixer, setFixer] = useState<string | null>(null);
  useEffect(() => bridge.onReview(setReview), [bridge]);
  const act = (action: ViewAction) => void send(action).catch(() => {});
  const running = review !== null && isRunning(review);
  useEffect(() => {
    if (!running) setConfirmStop(false);
  }, [running]);
  // A reviewer taken off the council has no panel to show any more.
  const openedGone = reviewerId !== null && review !== null && !review.reviewers.some((reviewer) => reviewer.id === reviewerId && reviewer.enabled);
  useEffect(() => {
    if (openedGone) setReviewerId(null);
  }, [openedGone]);
  const now = useNow(review !== null && isRunning(review));
  const phase = review?.phase;
  // Who fixes: asked once the review is complete, again when the window regains focus (the header setting may have changed) and after each fix.
  const complete = phase === "complete";
  const fixRequests = review?.findings.filter((finding) => finding.fix).length ?? 0;
  useEffect(() => {
    if (!complete) return;
    let live = true;
    const ask = () => {
      // A query, not the user's action: past the send queue, so it neither shows as busy nor clears a problem shown.
      Promise.resolve(bridge.send({ kind: "fixer" })).then(
        (result) => {
          const profile = (result as { profile?: string | null } | null)?.profile;
          if (live) setFixer(typeof profile === "string" ? profile : null);
        },
        () => {},
      );
    };
    ask();
    window.addEventListener("focus", ask);
    return () => {
      live = false;
      window.removeEventListener("focus", ask);
    };
  }, [complete, bridge, fixRequests]);
  // Move to the Council tab when the deliberation starts, unless the user has chosen a tab themselves or has a reviewer's panel open (a nudge in the header offers the move instead).
  useEffect(() => {
    if (phase === "deliberation" && !picked && !reviewerOpen.current) setTab("council");
  }, [phase, picked]);

  if (!review) return <div className="loading">Loading the review…</div>;

  const hasCouncil = review.rounds > 0;
  // The reviewer panel belongs to the Workspace tab: any tab change closes it.
  const choose = (next: Tab, keepFocus = false) => {
    setPicked(true);
    setTab(next);
    setReviewerId(null);
    if (!keepFocus) setFocus(null);
  };
  const openFinding = (id: string) => {
    setFocus(id);
    choose(hasCouncil ? "council" : "findings", true);
  };
  const openInCouncil = (id: string) => {
    setFocus(id);
    choose("council", true);
  };
  const openReviewer = (id: string, from?: HTMLElement) => {
    if (reviewerId === id) return closeReviewer();
    if (from) opener.current = from;
    setReviewerId(id);
  };
  const closeReviewer = () => {
    setReviewerId(null);
    const from = opener.current;
    opener.current = null;
    if (from?.isConnected) from.focus();
  };
  const tabs: Tab[] = hasCouncil ? ["workspace", "council", "findings"] : ["workspace", "findings"];
  const onTabKey = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(shownTab) + step + tabs.length) % tabs.length]!;
    choose(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };
  const shownTab: Tab = tab === "council" && !hasCouncil ? "workspace" : tab;
  const nudge = review.phase === "deliberation" && hasCouncil && shownTab === "workspace" && reviewerId !== null;
  const target = review.target;
  const openPath = bridge.openFile ? (path: string) => bridge.openFile!(path === target || path.startsWith("/") ? path : `${target.replace(/\/$/, "")}/${path}`) : undefined;
  const seatedList = seatedReviewers(review);
  const seated = seatedList.length;
  const failed = seatedList.filter((reviewer) => reviewer.status === "failed").length;
  const time = elapsed(review.startedAt, review.endedAt, now);

  return (
    <FixerContext.Provider value={fixer}>
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <span className="brand-name">Spectra Council</span>
          {review.phase !== "setup" && (
            <span className="target mono" title={target}>
              <bdi>{target}</bdi>
            </span>
          )}
        </div>
        <div className="top-end">
          {nudge && (
            <button className="nudge" onClick={() => choose("council")}>
              Deliberation started → Council
            </button>
          )}
          <PhasePill phase={review.phase} />
        </div>
      </header>
      <div className="chips">
        <span className="chip static">{PROFILES[review.profile].title} review</span>
        <span className="chip static">
          {failed > 0 ? `${seated - failed} of ${seated} reviewers · ${failed} failed` : `${seated} reviewer${seated === 1 ? "" : "s"}`}
        </span>
        <span className="chip static" title={`${review.deliberationRounds} deliberation round${review.deliberationRounds === 1 ? "" : "s"}, at most ${review.maxFindings} finding${review.maxFindings === 1 ? "" : "s"} per reviewer`}>
          {DEPTH_TITLES[review.depth]} depth · ≤{review.maxFindings} findings each
        </span>
        {hasCouncil && (
          <span className="chip static">{review.phase === "deliberation" ? `Round ${review.round} of ${review.rounds}` : `${review.rounds} round${review.rounds === 1 ? "" : "s"}`}</span>
        )}
        {review.verifications > 0 && <span className="chip static">Re-check {review.verifications}</span>}
        {review.runner === "mock" && seated > 0 && (
          <span className="chip static mock" title="Deterministic mock reviewers: their findings are illustrative, not an analysis of your files.">
            Mock reviewers
          </span>
        )}
        {review.runner === "mixed" && (
          <span className="chip static mock" title="The mock seats' findings are illustrative, not an analysis of your files.">
            Some mock reviewers
          </span>
        )}
      </div>

      {problem && (
        <div className="problem" role="alert">
          {problem}
          <button className="icon-button" onClick={() => setProblem(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {review.phase === "setup" ? (
        <Setup review={review} bridge={bridge} busy={busy} configure={(patch: SetupPatch) => void send({ kind: "configure", patch }).catch(() => {})} start={() => void send({ kind: "start" }).catch(() => {})} />
      ) : (
        <>
          <nav className="tabs" role="tablist" aria-label="Review views" onKeyDown={onTabKey}>
            <button role="tab" id="tab-workspace" aria-controls="panel" tabIndex={shownTab === "workspace" ? 0 : -1} aria-selected={shownTab === "workspace"} className={cx(shownTab === "workspace" && "chosen")} onClick={() => choose("workspace")}>
              Workspace
            </button>
            {hasCouncil && (
              <button role="tab" id="tab-council" aria-controls="panel" tabIndex={shownTab === "council" ? 0 : -1} aria-selected={shownTab === "council"} className={cx(shownTab === "council" && "chosen")} onClick={() => choose("council")}>
                Council
              </button>
            )}
            <button role="tab" id="tab-findings" aria-controls="panel" tabIndex={shownTab === "findings" ? 0 : -1} aria-selected={shownTab === "findings"} className={cx(shownTab === "findings" && "chosen")} onClick={() => choose("findings")}>
              Findings <span className="muted">{review.findings.length}</span>
            </button>
          </nav>
          <div className={cx("body", reviewerId && shownTab === "workspace" && "with-detail")}>
            <main role="tabpanel" id="panel" aria-labelledby={`tab-${shownTab}`}>
              {shownTab === "workspace" ? (
                <Workspace
                  review={review}
                  now={now}
                  openReviewer={openReviewer}
                  openedReviewer={reviewerId}
                  openFinding={openFinding}
                  openAll={() => choose("findings")}
                  openCouncil={() => choose("council")}
                  rerun={() => send({ kind: "rerun" })}
                  resume={() => send({ kind: "resume" })}
                  act={act}
                  busy={busy}
                  {...(openPath ? { openPath } : {})}
                />
              ) : shownTab === "council" ? (
                <Deliberation key={focus ?? ""} review={review} focus={focus} act={act} busy={busy} {...(openPath ? { openPath } : {})} />
              ) : (
                <Findings review={review} focus={focus} openInCouncil={openInCouncil} {...(openPath ? { openPath } : {})} />
              )}
            </main>
            {reviewerId && shownTab === "workspace" && (
              <ReviewerDetail review={review} reviewerId={reviewerId} now={now} close={closeReviewer} act={act} busy={busy} openFinding={openFinding} {...(openPath ? { openPath } : {})} />
            )}
          </div>
          <footer className="bar">
            <span>
              Phase: <strong>{PHASE_WORDS[review.phase]}</strong>
              {time && <span className="muted"> · {time}</span>}
              {isFinished(review) && <span className="muted"> · {review.findings.length} findings</span>}
            </span>
            {isRunning(review) &&
              (confirmStop ? (
                <span className="stop-confirm" role="group" aria-label="Confirm stop">
                  <span>Stop all reviewers?</span>
                  <button className="danger" disabled={busy} onClick={() => (setConfirmStop(false), void send({ kind: "stop" }).catch(() => {}))}>
                    Stop
                  </button>
                  <button autoFocus onClick={() => setConfirmStop(false)}>
                    Keep running
                  </button>
                </span>
              ) : (
                <button disabled={busy} onClick={() => setConfirmStop(true)}>
                  Stop review
                </button>
              ))}
          </footer>
        </>
      )}
    </div>
    </FixerContext.Provider>
  );
}
