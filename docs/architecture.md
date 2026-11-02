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

After the independent reviews, the reviewers that finished deliberate (`core/deliberation.ts`). The round counts are
quick 2, standard 3 and deep 4. Each round emits `round-started`, then one `argued` per reviewer (backs, challenges or
is unsure about a finding, with evidence). Reporters answer challenges with `argued` too. Then `synthesis-started`
and one `finding-resolved` per finding (`agreed`, `confirmed`, `disputed` or `withdrawn`), and `concluded` with the
verdict line. `deliberation-started` opens the phase. The settlement rules live in `settle`, and `verdictSummary`
writes the verdict. Stored reviews from the earlier format are upgraded on read (`upgradeReview`).

After the verdict, the review moves through the `verification` phase too. `fix-proposed` attaches a proposed fix to each
finding that stands (drafted by its reporter through `ReviewerRunner.propose`), and `ruled` records the user's Accept,
Dismiss or Later. `handoff-written` marks the hand-off file that `core/handoff.ts` renders. `fix-requested` sends the
agent the accepted findings, and `fix-reported` records each fix from `council_mark_fixed`. With a fixer profile chosen
(the plugin's profile setting `fixer`), the agent calls `council_delegate_fix`, which starts a conversation on that
profile (`fix-delegated`); only a tool may start one. That conversation can't reach the review's canvas, so it ends its
reply with a JSON report (`core/fixer.ts`), which `replied` turns into `fix-reported` and `fix-failed`. `verification-started` opens
the phase, where `ReviewerRunner.verify` has each reporter and backer check a fix (`fix-checked`), and
`verification-ended` closes it with each fix verified or reopened.

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
- **Deliberation turns.** Real reviewers also need a deliberation turn: a `council_argue` tool alongside
  `council_report_finding`, which takes a finding's stance (backs, challenges, unsure) with evidence, or a rebuttal.
  Each round starts one fresh conversation per reviewer, so the mock's round loop and `argued` events carry over.
- **Propose and verify turns.** After the verdict, real reviewers need two more turns: `council_propose_fix` for a
  finding's proposed fix (summary, steps, files, how to verify, risks), and `council_check_fix` for a re-check that
  ends verified or reopened, with evidence. Each turn starts a fresh conversation per reviewer, as the deliberation
  rounds do.
- Constraint: conversations a plugin started can't start more (one level). Each deliberation round therefore starts
  fresh reviewer conversations from the chairing agent, which suits anonymous cross-review.

## Later milestones

3. **Independent reviews in earnest**: reviewer briefs per profile and depth, evidence with line ranges and quotes,
   evidence checked against the files (a cited line must exist), a report exported to the target as Markdown.
4. **Deliberation and follow-up**: done with mocks (the protocol, the settlement rules, the verdict, the view's Council
   tab, rulings, the hand-off file, fix requests and the re-check). Still to do: real agents in the rounds, real fixes
   and re-checks, and normalising duplicate findings (the mocks deliberately report overlapping ones).
5. **Advanced UI**: findings explorer, evidence viewer, report export. The deliberation timeline per finding is done.

Then, if wanted, a standalone Electrobun app: `hosts/desktop/` with its own `CouncilBridge`, a direct-ACP runner, and
its own persistence, as neo-manuscript does.
