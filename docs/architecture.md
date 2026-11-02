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

## Milestone 2: real reviewers through Mirador

- **Seats.** A seat is a mock persona or a Mirador profile. A profile seat's agent id is `profile:<name>`, and
  `agentLabel` shows the name. The setup picks profile seats by name, and offers the names seated before. Mocks and
  profiles can sit at one council: `routeByAgent` (core/engine.ts) sends each reviewer to the mock runner or the agent
  runner. `review.runner` is `"mock"`, `"mirador"` or `"mixed"`.
- **Turns.** Each turn starts one fresh conversation per seat: the independent review, each deliberation round, the fix
  proposals and each re-check. Fresh conversations per round suit anonymous cross-review. Each prompt is self-contained
  (core/agent-turns.ts): the target, a read-only rule, the profile's brief and focus, the depth, the user's
  instructions, the turn's task, and the JSON reply shape with its schema and an example.
- **Reporting.** The agent ends its final message with a JSON code block. The schemas are `reviewReplySchema`,
  `deliberationReplySchema`, `proposalReplySchema` and `verificationReplySchema` (core/schemas.ts), and `lastJson`
  (core/replies.ts) reads the block. `AgentRunner` (core/agent-runner.ts) reports each item, and the session validates
  each one. A malformed item shows as an error, and the rest of the turn still counts. A reply without the block, or a
  conversation that was stopped or failed, fails the seat's turn. Each turn has a 15 minute limit (`TURN_LIMIT_MS`).
  This is the fixer's approach (core/fixer.ts). It asks the least of models that call tools unreliably, and Mirador
  keeps a reply across a restart.
- **Starting.** Only a tool may start a conversation. The host keeps the tool context of the latest tool call in each
  conversation (`council_open`, `council_status`, and so on) and starts the reviewers' conversations through it.
  `Conversations` (core/engine.ts) is the host-neutral interface: `ask` starts one conversation and resolves when its
  turn ends, and the host resolves each ask in `replied`. When there is no kept context, after a Mirador restart, Start
  asks the agent to call `council_begin`, and that tool starts the review.
- **Limits.** Seats run in parallel. Stop aborts the review. Started conversations run on, and their replies are
  ignored. A Mirador restart interrupts a running review, as before.
- **Model and effort.** A seat runs on its profile's defaults. [mirador-api.md](mirador-api.md) lists the API
  extensions that would allow more.

## Later milestones

3. **Independent reviews in earnest**: reviewer briefs per profile and depth, evidence with line ranges and quotes,
   evidence checked against the files (a cited line must exist), a report exported to the target as Markdown.
4. **Deliberation and follow-up**: done with mocks (the protocol, the settlement rules, the verdict, the view's Council
   tab, rulings, the hand-off file, fix requests and the re-check). Real agents in the rounds, proposals and re-checks
   are done in milestone 2. Still to do: normalising duplicate findings (the mocks deliberately report overlapping ones).
5. **Advanced UI**: findings explorer, evidence viewer, report export. The deliberation timeline per finding is done.

Then, if wanted, a standalone Electrobun app: `hosts/desktop/` with its own `CouncilBridge`, a direct-ACP runner, and
its own persistence, as neo-manuscript does.
