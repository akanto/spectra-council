# Development

Spectra Council is a [Mirador](https://github.com/sodre90/mirador) canvas plugin (plugin API 5): a host module Mirador
runs (`hosts/mirador/host.ts`) and a React view it loads into the canvas (`dist/view.js`). The engine in `core/` knows
nothing of either, so another host (a standalone app) could run it.

## Set up

```bash
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/spectra-council   # then restart Mirador
```

Mirador loads plugins when it starts, so changes to `hosts/mirador/host.ts` or `plugin.json` need a restart. The view is
read each time a review opens, so `bun run build` is enough for view changes.

## Commands

```bash
bun run typecheck
bun test tests                        # reducer, engine, deliberation, mock reviewers and Mirador host, on a fake clock
bun run build                         # dist/view.js; SPECTRA_MINIFY=0 for a readable bundle
bun run harness [target]              # the view against a stand-in for Mirador: http://127.0.0.1:4830 (?theme=dark)
bun scripts/screenshots.ts            # with the harness running: a mock review in Chrome, screenshots in .harness/
bun run e2e                           # build, then a mock review in Chrome and in WebKit framed as Mirador frames it
bun run api-compat                    # hosts/mirador/api.ts against Mirador's plugin API types
```

**Harness.** It runs mock reviewers only: it has no Mirador profiles, so profile seats fail there. It answers on
`127.0.0.1:<port>` (or `localhost:<port>`) and refuses other Host headers. The page's socket must come from that origin
and first send a random token that only the page carries, made when the harness starts. Open the page in a browser
rather than connecting to `/socket` yourself.

**e2e** needs Chrome, and for the framed run WebKit (`bunx playwright-core install webkit`) and Mirador's
`shared/canvas-document.ts` (the installed app's, or `MIRADOR_CANVAS`). A setup that can't run is skipped. **api-compat**
reads Mirador's `shared/` from `MIRADOR_SHARED`, `.mirador/shared` or the installed app.

**CI** (`.github/workflows/ci.yml`) runs the typecheck, tests, build, API check and e2e on macOS, against the Mirador tag
`MIRADOR_REF` pins. Bumping that pin is how the plugin moves to a newer Mirador.

## Layout

| Folder | What | Depends on |
| --- | --- | --- |
| `core/` | The engine: model, Zod schemas, events and reducer (`review.ts`), `ReviewSession` and the runner interface (`engine.ts`), deliberation and settlement, the agent and mock runners, prompts, the hand-off, fixer and ticket prompts | Bun only |
| `view/` | The React UI. It draws the `Review` it is handed and sends `ViewAction`s through a `CouncilBridge`; it runs no orchestration | `core/` types and pure helpers |
| `hosts/mirador/` | The canvas host (tools, actions, persistence), the view's entry, the read-only reader of Mirador's records, and a copy of Mirador's API types (`api.ts`) | `core/`, `view/` |
| `scripts/` | Build, harness, screenshots, release, API check | |
| `tests/`, `e2e/` | Bun tests; browser tests against the built view | |

## How it works

### Decisions

- **Event-sourced state.** `reduce(review, event)` (`core/review.ts`) is the only way a review changes: deterministic,
  testable and the same in every host. New behaviour is a new event, a reducer case and a test.
- **Reviewers are Mirador conversations.** A seat is a Mirador profile (`profile:<name>`) or a mock persona. Mirador
  already runs Claude, pi and opencode with sign-in, permissions and transcripts; the plugin owns what Mirador doesn't:
  findings, deliberation, synthesis and the fix loop.
- **A runner interface.** `ReviewerRunner` (`core/engine.ts`) runs a reviewer's turns: `AgentRunner` through Mirador
  conversations, `MockRunner` for demos and tests. `routeByAgent` lets mocks and profiles sit at one council.
- **Persistence is canvas item data.** Mirador stores items and streams each change to the view. There is no database
  or socket layer of our own.
- **Plain CSS on Mirador's theme variables**, so the view matches its light and dark themes and ships as one file.

### A review, phase by phase

`ReviewSession` drives the phases and emits events; the host applies them to the canvas item, throttled for the view.

1. **Setup.** The agent calls `council_open`; the user picks profile, depth, seats and instructions in the canvas
   (`configure`), then starts it. Depth is two knobs (`core/depth.ts`): deliberation rounds (1 to 6) and the most
   findings per reviewer (1 to 20).
2. **Independent review.** Each seat reviews the target on its own (`finding-reported`). A reviewer's findings past the
   limit are cut, most severe kept (`findings-capped`). Duplicates merge (`findings-merged`, `core/duplicates.ts`); with
   a real agent at the council, a grouping turn merges findings by meaning before round 1.
3. **Deliberation.** Each round (`round-started`) every reviewer backs, challenges or is unsure about findings, with
   evidence (`argued`); reporters answer challenges the same way.
4. **Synthesis.** `settle` (`core/deliberation.ts`) settles each finding from each reviewer's last stance
   (`finding-resolved`):
   - **withdrawn**: no reporter backs it any more;
   - **disputed**: someone's challenge still stands, however many back it; the dissent is kept with each dissenter's
     reason (the minority report);
   - **agreed**: nobody challenged it and everyone backs it;
   - **confirmed**: otherwise, when someone backs it. A challenge counts as answered only when its challenger came round.

   A reviewer that failed keeps the stance it recorded on each finding, its report included (`countsIn`): a timeout
   neither answers a challenge nor takes back support, and the rationale says it couldn't continue. A finding nobody
   backs (its reporters removed) stays unsettled. `verdictSummary` writes the verdict line (`concluded`).
5. **Proposals.** Each standing finding's reporter drafts a fix (`fix-proposed`).
6. **Rulings and fixes.** The user accepts, dismisses or defers each finding (`ruled`). `core/handoff.ts` renders the
   hand-off, rewritten whenever its text would change (`handoff-written` keeps a digest). `fix-requested` hands over
   only what awaits a request (`awaitsFixRequest`: newly accepted, reopened, or failed), so work in progress stays with
   its fixer. The fix is reported with `council_mark_fixed` (`fix-reported`), or by a fixer profile's conversation
   started with `council_delegate_fix` (`fix-delegated`), whose final JSON report (`core/fixer.ts`) becomes
   `fix-reported` and `fix-failed`. Tickets (`tickets-requested`, `ticketed`) and the user's own asks (`asked`,
   `ask-delegated`, `ask-answered`) work the same way.
7. **Re-check.** `verification-started` has each fixed finding's reporter and backers check the fix (`fix-checked`);
   `verification-ended` marks each fix verified or reopened.

Every change from outside the engine goes through the host's `applyTo`, which hands it to the running session when
there is one; a direct write would be lost under the session's next one.

### Real reviewers in Mirador

- **Turns.** Every turn (review, grouping, each round, proposals, each re-check) starts a fresh conversation per seat
  with a self-contained prompt (`core/agent-turns.ts`): the target, a read-only rule, the profile's brief, the user's
  instructions, the task, and the JSON reply shape with its schema and an example. Turns run in parallel, 15 minutes
  each at most (`TURN_LIMIT_MS`).
- **Replies.** The reply ends with a JSON block (`lastJson`, `core/replies.ts`) checked against the turn's schema in
  `core/schemas.ts`. A malformed item shows as an error and the rest still counts. A reply with no usable block is asked
  about once more in a new conversation (`repairPrompt`); a second miss fails the turn.
- **Starting conversations.** Only a tool may start one, so the host keeps the tool context of the latest tool call in
  each conversation and starts reviewers through it. After a Mirador restart there is none: Start, Resume and Re-check
  ask the agent to call `council_begin`, which starts the work.
- **Failures.** A reviewer that fails in the independent review can be retried (`reviewer-retried`) or, at any time,
  removed (`reviewer-removed`): it no longer counts in the synthesis or the verdict.
- **Resume.** A restart cuts a running review short (`interrupted`). Resume (`resumed`) redoes only the work in flight.
  The host keeps the conversations it started in plugin storage, with any reply that came while nothing waited for it,
  and a resumed turn takes its conversation over. Turns are matched by identity (review, reviewer, task, round or pass,
  findings, first ask or repair), not by prompt, which changes when a seat's label follows its model.
- **Model names.** A seat runs on its profile's model and effort. The plugin API can't read them, so
  `hosts/mirador/records.ts` reads Mirador's database read-only to name each seat by its model (`model-seen`).
  [mirador-api.md](mirador-api.md) lists the API extensions that would replace this and let a seat choose its model.
- **Limits.** Stop aborts the review, but the reviewers' conversations run on until their turn ends; their replies are
  ignored.

## Releasing

```bash
bun run release 0.2.0                    # on a clean main: sets the version in package.json and plugin.json,
                                         # commits "Release v0.2.0" and tags v0.2.0
git push --atomic origin main v0.2.0     # the script prints this and does not push
```

The tag starts `.github/workflows/release.yml`: it checks the tag against both versions, runs `ci.yml`, and publishes a
GitHub release with a tarball of `plugin.json` and `dist/view.js`. Mirador's plugin store installs at the tag and runs
`build`, so the tarball is a convenience copy.
