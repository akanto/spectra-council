# Development

Spectra Council is a [Mirador](https://github.com/sodre90/mirador) canvas plugin (plugin API 5). The product idea is in
[vision.md](vision.md), and the decisions and roadmap are in [architecture.md](architecture.md).

## Set up

```bash
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/spectra-council   # then restart Mirador
```

Mirador loads plugins when it starts, so changes to `hosts/mirador/host.ts` or `plugin.json` need a restart. The view
(`dist/view.js`) is read each time a review opens, so a `bun run build` is enough for view changes.

## Commands

```bash
bun run typecheck
bun test tests                        # reducer, mock reviewers, engine and Mirador host, on a fake clock
bun run build                         # dist/view.js; SPECTRA_MINIFY=0 for a readable bundle
bun run harness [target]              # the view against a stand-in for Mirador: http://127.0.0.1:4830 (?theme=dark)
bun scripts/screenshots.ts            # with the harness running: a review in Chrome, screenshots in .harness/
```

## Using it in Mirador

Ask the agent for a council review. It opens one in the canvas with `council_open`, and you set it up and start it
there:

1. **Setup**: the profile (General, Code, Architecture, Security, Scientific), the depth (Quick, Standard, Deep), who sits
   in the four seats, and optional instructions. The target is the project the conversation works in. To review
   something narrower, like one document, ask the agent for that when it opens the review.
2. **Workspace**: one panel per seat with the reviewer's status, current step and latest steps. Click a panel for its
   full activity timeline. **Stop** ends the review.
3. **Council**: the findings on the left, each with every reviewer's stance on it. Select one to see the positions, how
   it was resolved, and the argument round by round. A disputed finding shows its *Minority report*, so the dissent
   stays on the record.
4. **Findings**: sorted by severity, filterable by reviewer, severity and status. Open one for its summary, confidence,
   evidence (click a path to open the file) and recommendation.
5. **Rule**: once the verdict is in, each finding that stands (agreed, confirmed or disputed) has a proposed fix, drafted
   from the deliberation. In the Council tab, mark it Accept, Dismiss or Later, with an optional note. For a disputed
   finding the minority report sits right above the ruling.
6. **Hand-off**: *Write hand-off* writes the accepted findings to `<target>/.spectra-council/review-<id>.md`. Each one
   has what's wrong, the evidence, how the council got there (rationale, arguments by round, any minority report) and
   the proposed fix with how to verify it. Dismissed and deferred findings are listed too, so they're left alone.
7. **Fix**: *Ask agent to fix* sends the conversation's agent a message to fix the accepted findings in the hand-off,
   most severe first. The agent reports each fix with the `council_mark_fixed` tool, and the finding shows as fixed.
   To have another profile fix them (pi with GLM, say, or any other agent and model), pick it as the conversation's
   **Spectra Council fixer** in the conversation header. *Ask pi glm to fix* then has the agent call
   `council_delegate_fix`, which starts a conversation on that profile with the hand-off. That conversation ends with a
   short JSON report of what it fixed and what it didn't, and the review shows each finding as fixed or says why not.
8. **Re-check**: *Re-check fixes* starts a verification round in which each fixed finding's reporter and backers check
   the fix. It ends verified or reopened, and reopened findings can be handed off again.

When the deliberation ends, a verdict banner shows at the top of the review with a one-line verdict. The agent hears
about the review with your next message, and `council_status` gives it every finding and its status. Reviews are canvas items, so Mirador keeps them across restarts. A review that was running
when Mirador stopped shows as *interrupted*.

In Mirador Settings, under the plugin, the **Open reviews** setting chooses where a review opens: beside the chat
(the default) or full screen.

## Layout

| Folder | What | Depends on |
| --- | --- | --- |
| `core/` | The review engine: model, Zod schemas, events and reducer, the deliberation protocol (rounds, settlement rules, verdict), rulings and the fix loop, the hand-off document (`handoff.ts`), profiles, agent registry, `ReviewSession` with its runner interface, mock reviewers, descriptions for the agent | Bun only |
| `view/` | The React UI, given a `CouncilBridge` | `core/` types and pure helpers |
| `hosts/mirador/` | The canvas host (tools, actions, persistence as canvas items), the view's entry with `window.mirador`, and a copy of the Mirador API types | `core/`, `view/` |
| `scripts/` | Build, harness, screenshots | |
| `tests/` | Bun tests | |

A standalone desktop app would go in a new folder under `hosts/`, with its own `CouncilBridge` and runner.
