# Vision

The product as first specified. Where this conflicts with `docs/architecture.md`, the architecture doc wins: Spectra
Council is built first as a Mirador plugin, so the Electrobun shell, SQLite, WebSocket layer and the `src/bun` /
`src/renderer` layout below are superseded (for now) by Mirador's canvas, its persistence, and `core/` + `view/` +
`hosts/mirador/`.

## Product

Spectra Council is not a chat application. It is a **multi-agent review workbench**. You open it, select a repository
or document, choose AI agents, and watch them independently investigate and then debate their findings.

The interface emphasises independent analysis, evidence, findings, disagreement, deliberation, and transparent
conclusions. Visual design: modern, restrained, information-dense, suitable for professional engineering and
scientific research. It shows the agent events that are available, never claims access to private model reasoning.

> Mirador visualizes agent work; Spectra Council visualizes how independent agents evaluate evidence and challenge
> one another's conclusions.

## Three views

**A. Review setup.** The user selects the repository or document to review; a review profile (Scientific,
Architecture, Code, Security, or General); the participating agents; the review depth (Quick, Standard, Deep); and
optional custom instructions. Then **Start Review**.

**B. Live agent workspace.** A multi-panel layout, one panel per agent: its status (reviewing, completed), what it is
doing ("Examining equations", "Reading model.py"), and its findings count. Clicking an agent shows its full execution
history: file reads, tool calls, reasoning summaries the agent chose to report, and findings. A bar shows the phase
(e.g. Independent Review) with Pause, Stop and Details.

**C. Council deliberation.** After independent reviews, the view organises the discussion around individual findings
rather than chat windows. For example, *Finding #7: Potential experimental data leakage*, with each agent's position
(Supports / Challenges / Uncertain) and confidence, and below it a timeline of evidence and rebuttals. The user can open
the relevant code, experiment or manuscript section directly.

A sketch of the workspace: a "SPECTRA" header with a *Review running* status; chips for *Architecture review*,
*4 agents*, *Round 2 of 3*; four agent tiles (Codex "Challenging finding #3", Claude "Review complete", Gemini
"Checking evidence", Qwen "Responding to critique") each with a status mark; and a Findings list with a total and a
status per finding (*Unsupported scalability assumption* Confirmed, *Possible experimental bias* Disputed, *Missing
failure scenario* Agreed).

## The user's workflow

1. Launch Spectra Council.
2. Select a local repository, document, or project directory.
3. Select a review profile.
4. Select available AI agents.
5. Start a review.
6. Observe agents working concurrently in independent panels.
7. Inspect their findings.
8. Observe structured deliberation.
9. Explore supporting evidence.
10. Export the final report.

## Architectural requirements (still binding)

Separate desktop/host lifecycle, agent management, review orchestration, deliberation protocol, evidence management,
persistence, and UI presentation. The review engine must not depend on React components or host-specific APIs. The UI
must not implement orchestration logic.

## Milestones

1. **Workbench with mocks**: a polished multi-agent workspace, a target selector, a review-profile selector, four
   configurable agent panels, two deterministic mock agents running concurrently, activity streamed to the UI,
   structured findings collected and shown in their own view, sessions persisted. No real AI, no deliberation.
2. **Real agent execution**: Codex and Claude (and others) running concurrently, their activity streamed, results
   inspectable.
3. **Independent reviews**: select a repository, choose agents, collect structured findings independently.
4. **Council deliberation**: finding normalisation, anonymous cross-review, rebuttals, evidence verification,
   synthesis.
5. **Advanced UI**: deliberation timeline, findings explorer, evidence viewer, report export.
