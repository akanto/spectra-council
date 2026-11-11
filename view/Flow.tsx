import type { Flow, FlowState } from "../core/progress.ts";

const MARKS: Record<FlowState, string> = {
  done: "✓",
  current: "●",
  ahead: "○",
  skipped: "–",
  stopped: "✕",
  interrupted: "⏸",
};

const STATE_WORDS: Record<FlowState, string> = {
  done: "done",
  current: "current",
  ahead: "not yet",
  skipped: "skipped",
  stopped: "stopped",
  interrupted: "interrupted",
};

/** The review's six steps on one line, with where it is now. Read-only. */
export function FlowStrip({ flow, close }: { flow: Flow; close(): void }) {
  return (
    <section className="flow" aria-label="Review process">
      <ol className="flow-steps">
        {flow.steps.map((step, index) => (
          <li
            key={step.id}
            className={`flow-step flow-${step.state}`}
            aria-current={step.state === "current" ? "step" : undefined}
            title={step.explain}
          >
            {index > 0 && (
              <span className="flow-connector" aria-hidden="true">
                {step.id === "recheck" ? "⇄" : "→"}
              </span>
            )}
            <span className="flow-body">
              <span className="flow-head">
                <span className="flow-mark" aria-hidden="true">
                  {MARKS[step.state]}
                </span>
                <span className="flow-title">{step.title}</span>
                <span className="flow-sr">{STATE_WORDS[step.state]}</span>
              </span>
              <span className="flow-detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {flow.settled && <span className="flow-settled">All settled</span>}
      <button
        type="button"
        className="icon-button flow-close"
        aria-label="Hide the process"
        title="Hide the process (the phase pill shows it again)"
        onClick={close}
      >
        ✕
      </button>
    </section>
  );
}
