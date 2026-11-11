# Development

Spectra Council is a [Mirador](https://github.com/sodre90/mirador) canvas plugin (plugin API 8): a host module Mirador
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
| `video/` | The README's promo video: a take in a throwaway Mirador, scripted reviewers, the edit ([video/README.md](../video/README.md)). Nothing in it ships | `core/`, `hosts/mirador/` |

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
6. **Rulings and fixes.** The user accepts, dismisses or defers each finding (`ruled`), in the canvas or by telling the
   agent, which records it with `council_rule`. `core/handoff.ts` renders the
   hand-off, rewritten whenever its text would change (`handoff-written` keeps a digest). `fix-requested` hands over
   only what awaits a request (`awaitsFixRequest`: newly accepted, reopened, or failed), so work in progress stays with
   its fixer. The fix is reported with `council_mark_fixed` (`fix-reported`), or by a fixer profile's conversation
   started with `council_delegate_fix` (`fix-delegated`), whose final JSON report (`core/fixer.ts`) becomes
   `fix-reported` and `fix-failed`. Tickets (`tickets-requested`, `ticketed`) and the user's own asks (`asked`,
   `ask-delegated`, `ask-answered`, or `ask-failed` when the fixer's conversation couldn't start) work the same way. An
   accepted finding the user asked about needs no hand-off: a fixer's report on it gives it a fix (`fix-reported`
   fixed, `fix-failed` handed off with the reason).
7. **Re-check.** `verification-started` has each fixed finding's reporters and backers check the fix (`fix-checked`);
   `verification-ended` marks each fix verified or reopened. Only reviewers who completed the review check
   (`checkersOf`); when none of a finding's backers did, every reviewer who did checks it, and with none left the host
   refuses the re-check and says why. Each fix records the pass it was put to (`recheckedIn`); a pass that ends with no
   check back on one (its checkers' turns failed, say) leaves it fixed with a `problem` saying so, cleared when the next
   re-check starts. A stopped pass marks nothing.

Every change from outside the engine goes through the host's `applyTo`, which hands it to the running session when
there is one; a direct write would be lost under the session's next one.

### Real reviewers in Mirador

- **Turns.** Every turn (review, grouping, each round, proposals, each re-check) starts a fresh conversation per seat
  with a self-contained prompt (`core/agent-turns.ts`): the target, a read-only rule, the profile's brief, the user's
  instructions, the task, and the JSON reply shape with its schema and an example. Turns run in parallel, 15 minutes
  each at most (`TURN_LIMIT_MS`), or what the conversation's profile sets as its **Spectra Council turn limit**
  (`turnLimitOf`, `hosts/mirador/host.ts`).
- **Replies.** The reply ends with a JSON block (`lastJson`, `core/replies.ts`) checked against the turn's schema in
  `core/schemas.ts`. A malformed item shows as an error and the rest still counts. A reply with no usable block is asked
  about once more in a new conversation (`repairPrompt`); a second miss fails the turn.
- **Starting conversations.** Only a tool may start one, so the host keeps the tool context of the latest tool call in
  each conversation and starts reviewers through it. After a Mirador restart there is none: Start, Resume and Re-check
  ask the agent to call `council_begin`, which starts the work.
- **The agent's other tools.** `council_stop` does what the view's Stop does, but only for a running session: a review
  a restart left running reads as interrupted, with nothing to stop. A stop also stops the reviewers' conversations it
  started, through `stopConversation` (Mirador's plugin API 10); on a Mirador older than that there is no way to, so
  their turns run on to their end, and their replies are ignored. `council_profiles` lists
  `profilesFor` (Mirador's records, else the profiles seated before) as `council_open`'s agents name them.
  `council_rule` records a ruling the user gave the agent; what the view's `rule` would prompt the agent with (a filed
  issue on a finding no longer accepted, a fix taken back) comes back in the tool's result instead.
- **Telling the user.** A run that reaches its verdict prompts the review's own conversation once (`finishedPrompt`,
  `hosts/mirador/host.ts`), asking its agent to tell the user in a line or two: the outcome the canvas's bar shows, and
  how many reviewers failed. A re-check of fixes that ends complete tells again; one the user stopped tells nothing by
  either channel: the review returns to the verdict its conversation already heard, its heard mark stays set, and the
  note only lists what nobody heard. The prompt goes in the plugin's own voice, through the conversation's kept tool
  context (a view action's would read as the user's), and isn't awaited: it resolves only when the turn it starts ends.
  It marks the review heard first, so the note never repeats the verdict on that turn: the note carries only what ended
  without a prompt — a stop, a late finding, or a verdict with no tool context since a restart. A restart doesn't lose a
  verdict marked so: Mirador records the prompt as it takes it, in the conversation's queue, which it keeps across a
  restart and sends from the next host, or as the message of the turn it starts (on a Codex conversation whose session
  it held back, only once that session opens). A send that fails takes back the mark it set, but not a later run's. A
  review a restart cut short tells nothing by either channel until the user resumes it: the `interrupted` stamp
  `settled` computes is a read-time view never written back, and the note only lists reviews stored as ended; once
  resumed, the run tells its verdict as usual. A fixer conversation's reply is told the same way
  (`fixerFinishedPrompt`): once per reply, what it fixed and what it didn't with the reasons, and the beads issues it
  filed. Only a launch prompts, so a restart, a replay or a rebuilt canvas says nothing. These need Mirador 0.8.0
  (plugin API 5, the floor `plugin.json` declares), where `replied`'s context is the conversation that started the one
  replying, its `prompt` speaks in the plugin's voice, and a reply owed across a restart is delivered. `"tellsCaller":
  true` in `plugin.json` has a Mirador newer than 0.12.0 leave out its own ping for each started conversation's first
  turn end (`docs/mirador-api.md`, 8); an older one ignores the field and pings as well, so there the user hears both.
- **Failures.** A reviewer that fails in the independent review can be retried (`reviewer-retried`) or, at any time,
  removed (`reviewer-removed`): it no longer counts in the synthesis or the verdict. A turn past its limit fails with a
  `TurnTimeout` ("Its turn took longer than 15 minutes"), which is also the reason its ask is aborted with.
- **Late replies.** A seat that failed its own review turn (timed out, say) can take the reply its conversation gave
  after all: the view offers "Fetch its reply" while the reviewers review and once the review is complete (`whyNoFetch`,
  `core/late-replies.ts`). The seat's activity names the turn and its conversation (`Asking the … profile to review`,
  `Started conversation <id>`), so reviews stored before this work too. A conversation the limit gave up on stays in the
  host's in-flight records (`gaveUp`): never taken over by a resume or retry, but its reply is kept when Mirador sends
  it. A kept reply that finished is told once to the review's conversation (`lateReplyPrompt`): the user can fetch it
  now, or once the review reaches its verdict when the council is at work (`whenFetchable`); told once, that window says
  the reply stays only in the seat's own conversation if the review never gets there, as a stopped review refuses the
  fetch. The fetch uses that reply, else reads the conversation's latest turn from Mirador's database (`replyOf`,
  `hosts/mirador/records.ts`, the agent's last message as Mirador's own `replyOf` reads it). A turn still running, ended
  badly or without a valid JSON block changes nothing: the view says why. Otherwise `replyFetched`
  (`core/agent-runner.ts`) reads it as the runner reads a review reply, and `reply-fetched` completes the seat with its
  findings (capped as usual), then:
  - **during the independent review**, they count as its review's, and the run goes on as before;
  - **on a complete review that ended without a deliberation**, when with the reply at least two reviewers finished
    and nothing was done with the verdict yet (no ruling, hand-off, fix, ticket, ask or re-check: `whyNoReopen`), the
    review is `reopened` to the end of its independent review and goes on as a run does (`ReviewSession.reopen`):
    merging, the grouping turn, the rounds, the synthesis, proposals and a new verdict. With no tool context to start
    conversations (after a restart) it waits as interrupted, and the agent is asked to call `council_begin`, which
    resumes it;
  - **otherwise** (it was deliberated, or the user already acted on its verdict) the findings come in `late`: never
    deliberated, ruled on as reported, counted apart in a rewritten verdict. The agent hears of the review again.

  A seat that failed in a deliberation round can't fetch: its round is over, and its arguments would land in a
  settled deliberation. Run the review again instead.
- **Resume.** A restart cuts a running review short (`interrupted`). Resume (`resumed`) redoes only the work in flight.
  The host keeps the conversations it started in plugin storage, with any reply that came while nothing waited for it,
  and a resumed turn takes its conversation over. Turns are matched by identity (review, reviewer, task, round or pass,
  findings, first ask or repair), not by prompt, which changes when a seat's label follows its model.
- **Models.** A profile seat runs on its profile's model and effort, or on a model and effort chosen for it (`model` and
  `effort` on its `Seat`, the reviewer's `choice`), which the runner passes to `startConversation` (plugin API 8);
  Mirador matches the model to the agent's by id or name, and shows the user in that conversation when it can't. The
  plugin API lists neither the models an agent offers nor the model a running conversation is on, so
  `hosts/mirador/records.ts` reads Mirador's database read-only for the setup's choices (the model and effort options of
  each profile's latest conversation), to name each seat by its model (`model-seen`), and to read a late reply that came
  while no host kept it. [mirador-api.md](mirador-api.md) lists the API extensions that would replace this.
- **Titles.** Every prompt opens with a title line (`turnTitle`); the host passes it as the conversation's `title`
  (`promptTitle`), which Mirador keeps from the agent's renames.
- **Other runners.** `createCouncilHost`'s `runnerFor` option hands an agent to a runner of the host's own, ahead of
  the mock and profile runners. The installed plugin passes none; the video's host (`video/lib/plugin-host.ts`) plays
  scripted reviewers through it.
- **Limits.** Stop aborts the review and stops the reviewers' conversations too; on a Mirador older than plugin API 10
  they run on until their turn ends, and their replies are ignored. A turn's limit is its total time (15 minutes), not
  its idle time.

## Releasing

```bash
bun run release 0.2.0                    # on a clean main: sets the version in package.json and plugin.json,
                                         # commits "Release v0.2.0" and tags v0.2.0
git push --atomic origin main v0.2.0     # the script prints this and does not push
```

The tag starts `.github/workflows/release.yml`: it checks the tag against both versions, runs `ci.yml`, and publishes a
GitHub release with a tarball of `plugin.json` and `dist/view.js`. Mirador's plugin store installs at the tag and runs
`build`, so the tarball is a convenience copy.
