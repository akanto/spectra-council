# Spectra Council

A multi-agent review workbench, built as a Mirador canvas plugin (plugin API 5). Product vision: `docs/vision.md`.
Architecture, decisions and roadmap: `docs/architecture.md`. Read both before changing the engine or the plugin shape.

## How to work in this repo (cost)

Plan, then delegate. Opus does the planning and the parts that need judgment. Separable, well-specified pieces go to
cheaper subagents in parallel: Sonnet for code, Haiku for mechanical work. Opus integrates and verifies the results.

1. **Opus first fixes the interfaces** the pieces share, and writes them itself: types in `core/model.ts`, events in
   `core/review.ts`, the runner in `core/engine.ts`, tool and action schemas in `core/schemas.ts`, and
   `hosts/mirador/api.ts`.
2. **Then it hands out pieces that own their files.** Good candidates:
   - Sonnet: a view component (`view/*.tsx`) and its CSS, given the `Review` shape; a runner implementation against
     `ReviewerRunner`; the tests for a module, given its behaviour; profile briefs and finding templates.
   - Haiku: docs, mock data, renames, harness and screenshot script tweaks.
3. **Each brief is self-contained.** It names the interface to code against, the files the worker owns, and how to
   check its work (`bun run typecheck`, `bun test tests/<file>`, `bun run build`). Workers don't commit.
4. **Opus keeps** small or tightly coupled changes, anything that edits a shared interface, and debugging the live app
   or harness. Opus integrates the results, runs typecheck, tests and build, and checks the view in the harness
   (`bun scripts/screenshots.ts`).

Delegate only when it is actually cheaper. A piece the worker could only get right by reading much of the codebase
stays with Opus. Say up front which pieces go to which model.

## Stack

- Bun runtime, TypeScript (strict, `moduleResolution: bundler`, `.ts`/`.tsx` extensions in imports,
  `noUncheckedIndexedAccess`).
- React 19 for the view; plain CSS on Mirador's `--mirador-*` theme variables (no Tailwind: the view must match
  Mirador's light and dark themes and ship as one file).
- Zod for everything that comes in from outside (tool inputs, view actions, reported findings); `z.toJSONSchema` makes
  the tool input schemas Mirador checks.
- No SQLite or WebSocket layer of our own: Mirador persists canvas items and streams them to the view.

## Rules

- `core/` must not import from `view/` or `hosts/`, nor use React or Mirador APIs. `view/` runs no orchestration: it
  draws the `Review` it is handed and sends `ViewAction`s. Only `hosts/mirador/` knows Mirador.
- A review changes only through `reduce` (core/review.ts). New behaviour = a new event + reducer case + test.
- Mock reviewers must stay deterministic: no `Math.random`, no wall clock in `mockScript`.
- Mirador's API types are a copy in `hosts/mirador/api.ts` (Mirador doesn't publish them). The source of truth is in
  the installed app: `~/Applications/Mirador.app/Contents/Resources/app/mirador/shared/canvas-plugins.ts` and
  `shared/canvas-document.ts`.
- Effects in the view need block bodies: `useEffect(() => el.scrollIntoView())` returns a promise in newer Chrome and
  WebKit, which React calls as a cleanup and crashes.
- After changing `view/`, run `bun run build` (Mirador loads `dist/view.js`) and check it in the harness.

## Commands

```bash
bun run typecheck && bun test tests && bun run build
bun run harness /path/to/target       # http://127.0.0.1:4830
bun scripts/screenshots.ts            # needs the harness running; writes .harness/*.png
```

Mirador loads plugins at start: after changing `hosts/mirador/host.ts` or `plugin.json`, Mirador needs a restart (the
user's call: it restarts their agent conversations too). `dist/view.js` is read when a canvas item opens.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
