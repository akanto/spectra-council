# Architecture

Spectra Council started as a spec for a standalone Electrobun desktop app (`docs/vision.md`). It is built first as a
**Mirador canvas plugin**, with the engine kept host-independent so a standalone app can follow.

## Decisions

| Decision | Why |
| --- | --- |
| A **canvas** plugin, not an app plugin | A review is not a document the user edits; it is a live item the agent opens and the user watches. Canvas tools also give the agent `council_open` / `council_status`, and API 5 lets a tool start conversations (below). |
| **Reviewers are Mirador conversations** (from milestone 2) | Mirador already runs Claude, pi and opencode over ACP, with sign-in, permissions, profiles and full transcripts. The plugin starts one conversation per seat with `startConversation({ profile, prompt })`; the user can open any reviewer's real transcript. The plugin owns what Mirador doesn't: findings, deliberation, synthesis. |
| Engine behind a **runner interface** | `ReviewerRunner` (core/engine.ts) is how a reviewer runs: `MockRunner` now, a Mirador-conversation runner next, a direct-ACP runner in a standalone app. |
| **Event-sourced review state** | `reduce(review, event)` is the only way a review changes: deterministic, testable, replayable, and the same in every host. |
| Persistence = **canvas item data** | Mirador stores items in its SQLite and sends them to the view on every change. No database of our own; `listed()` marks a review cut short by a restart as interrupted. |
| No Tailwind | The view uses Mirador's theme variables so it reads as part of Mirador in light and dark; plain CSS keeps the bundle a single file. |

## How a review runs (milestone 1)

```mermaid
sequenceDiagram
  participant U as User
  participant A as Mirador agent
  participant H as Canvas host (hosts/mirador)
  participant E as ReviewSession (core)
  participant V as View (React)
  U->>A: "Run a council review of this repo"
  A->>H: council_open { target, profile }
  H-->>V: item in setup
  U->>V: choose profile, depth, seats; Start review
  V->>H: action { kind: "start" }
  H->>E: run() with MockRunner
  loop each event from each reviewer
    E->>H: onChange(review)
    H-->>V: item data (throttled, 4/s)
  end
  E->>H: complete
  H-->>A: note with the user's next message
  A->>H: council_status
```

## Milestone 2 plan: real reviewers through Mirador

- **Seats from profiles.** The plugin declares profile settings (or a setting per seat whose choices are `"profiles"`),
  so the user picks which Mirador profiles (Claude/Home, Claude/Cloudera, pi, opencode with a GPT or Gemini model…)
  sit at the council. Agent ids become `profile:<name>`; `agentLabel` already shows them.
- **Starting reviewers.** `startConversation` is only available inside a tool call. So *Start review* in the view
  sends the agent a message (`prompt`) asking it to call `council_begin`, and that tool starts one conversation per
  seat with the reviewer brief (profile brief, target, depth, the user's instructions, and how to report).
- **Reporting.** Reviewers report through a canvas tool, `council_report_finding` (input = `findingInputSchema`),
  and progress through `council_report_progress`. Their tool context's `conversationId` maps them to their seat. The
  plugin keeps the starting conversation's context to update the review item.
- **Ending.** `replied(started, reply)` fires when a reviewer's turn ends: `finished` completes the seat, `failed` or
  `stopped` fails it. A runner for this is event-driven rather than a promise per reviewer; the reducer already takes
  its events.
- Constraint: conversations a plugin started can't start more (one level). Each deliberation round therefore starts
  fresh reviewer conversations from the chairing agent, which suits anonymous cross-review.

## Later milestones

3. **Independent reviews in earnest**: reviewer briefs per profile and depth, evidence with line ranges and quotes,
   evidence checked against the files (a cited line must exist), a report exported to the target as Markdown.
4. **Deliberation**: normalise duplicate findings (the mocks deliberately report overlapping ones), anonymous
   cross-review rounds where each reviewer supports, challenges or is uncertain about others' findings with confidence
   and evidence, rebuttals, then synthesis into a verdict per finding (`confirmed`, `disputed`, `agreed`, `withdrawn`).
5. **Advanced UI**: deliberation timeline per finding, findings explorer, evidence viewer, report export.

Then, if wanted, a standalone Electrobun app: `hosts/desktop/` with its own `CouncilBridge`, a direct-ACP runner, and
its own persistence, as neo-manuscript does.
