/** The Spectra Council view: setup, then the live workspace and the findings, around one review the host hands in. */
import { useCallback, useEffect, useRef, useState } from "react";
import { isFinished, isRunning, seatedReviewers, type Review } from "../core/model.ts";
import { DEPTH_LABELS, PROFILES } from "../core/profiles.ts";
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
  const { send, busy } = useSender(bridge, setProblem);
  const [fixer, setFixer] = useState<string | null>(null);
  useEffect(() => bridge.onReview(setReview), [bridge]);
  const act = (action: ViewAction) => void send(action).catch(() => {});
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
  // Move to the Council tab when the deliberation starts, unless the user has chosen a tab themselves.
  useEffect(() => {
    if (phase === "deliberation" && !picked) setTab("council");
  }, [phase, picked]);

  if (!review) return <div className="loading">Loading the review…</div>;

  const choose = (next: Tab) => {
    setPicked(true);
    setTab(next);
  };
  const openFinding = (id: string) => {
    setFocus(id);
    choose("findings");
  };
  const hasCouncil = review.rounds > 0;
  const shownTab: Tab = tab === "council" && !hasCouncil ? "workspace" : tab;
  const target = review.target;
  const openPath = bridge.openFile ? (path: string) => bridge.openFile!(path === target || path.startsWith("/") ? path : `${target.replace(/\/$/, "")}/${path}`) : undefined;
  const seated = seatedReviewers(review).length;
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
        <PhasePill phase={review.phase} />
      </header>
      <div className="chips">
        <span className="chip static">{PROFILES[review.profile].title} review</span>
        <span className="chip static">
          {seated} agent{seated === 1 ? "" : "s"}
        </span>
        <span className="chip static">{DEPTH_LABELS[review.depth].title} depth</span>
        {hasCouncil && (
          <span className="chip static">{review.phase === "deliberation" ? `Round ${review.round} of ${review.rounds}` : `${review.rounds} round${review.rounds === 1 ? "" : "s"}`}</span>
        )}
        {review.verifications > 0 && <span className="chip static">Re-check {review.verifications}</span>}
        {review.runner === "mock" && (
          <span className="chip static mock" title="Deterministic mock reviewers: their findings are illustrative, not an analysis of your files.">
            Mock reviewers
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
        <Setup review={review} busy={busy} configure={(patch: SetupPatch) => void send({ kind: "configure", patch }).catch(() => {})} start={() => void send({ kind: "start" }).catch(() => {})} />
      ) : (
        <>
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={shownTab === "workspace"} className={cx(shownTab === "workspace" && "chosen")} onClick={() => choose("workspace")}>
              Workspace
            </button>
            {hasCouncil && (
              <button role="tab" aria-selected={shownTab === "council"} className={cx(shownTab === "council" && "chosen")} onClick={() => choose("council")}>
                Council
              </button>
            )}
            <button role="tab" aria-selected={tab === "findings"} className={cx(tab === "findings" && "chosen")} onClick={() => choose("findings")}>
              Findings <span className="muted">{review.findings.length}</span>
            </button>
          </nav>
          <div className={cx("body", reviewerId && "with-detail")}>
            <main>
              {shownTab === "workspace" ? (
                <Workspace review={review} now={now} openReviewer={(id) => setReviewerId(reviewerId === id ? null : id)} openFinding={openFinding} act={act} busy={busy} {...(openPath ? { openPath } : {})} />
              ) : shownTab === "council" ? (
                <Deliberation review={review} focus={focus} act={act} busy={busy} {...(openPath ? { openPath } : {})} />
              ) : (
                <Findings review={review} focus={focus} {...(openPath ? { openPath } : {})} />
              )}
            </main>
            {reviewerId && (
              <ReviewerDetail review={review} reviewerId={reviewerId} now={now} close={() => setReviewerId(null)} openFinding={openFinding} {...(openPath ? { openPath } : {})} />
            )}
          </div>
          <footer className="bar">
            <span>
              Phase: <strong>{PHASE_WORDS[review.phase]}</strong>
              {time && <span className="muted"> · {time}</span>}
              {isFinished(review) && <span className="muted"> · {review.findings.length} findings</span>}
            </span>
            {isRunning(review) && (
              <button disabled={busy} onClick={() => void send({ kind: "stop" }).catch(() => {})}>
                Stop
              </button>
            )}
          </footer>
        </>
      )}
    </div>
    </FixerContext.Provider>
  );
}
