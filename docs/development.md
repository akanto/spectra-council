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

When the deliberation ends, a verdict banner shows at the top of the review with a one-line verdict. The agent hears about the review with your next message, and `council_status` gives it
every finding and its status. Reviews are canvas items, so Mirador keeps them across restarts. A review that was running
when Mirador stopped shows as *interrupted*.

In Mirador Settings, under the plugin, the **Open reviews** setting chooses where a review opens: beside the chat
(the default) or full screen.

## Layout

| Folder | What | Depends on |
| --- | --- | --- |
| `core/` | The review engine: model, Zod schemas, events and reducer, the deliberation protocol (rounds, settlement rules, verdict), profiles, agent registry, `ReviewSession` with its runner interface, mock reviewers, descriptions for the agent | Bun only |
| `view/` | The React UI, given a `CouncilBridge` | `core/` types and pure helpers |
| `hosts/mirador/` | The canvas host (tools, actions, persistence as canvas items), the view's entry with `window.mirador`, and a copy of the Mirador API types | `core/`, `view/` |
| `scripts/` | Build, harness, screenshots | |
| `tests/` | Bun tests | |

A standalone desktop app would go in a new folder under `hosts/`, with its own `CouncilBridge` and runner.
