# Spectra Council

Ask one AI to review your code and you get one opinion, delivered with full confidence. Spectra Council seats several:
Claude, Codex, Gemini, Qwen, or any model you run. Each reviews your work on its own, then they argue it out. Every
finding needs evidence, every challenge stays on the record, and you get a verdict you can check.

It's a plugin for [Mirador](https://github.com/sodre90/mirador).

[![Spectra Council in 90 seconds: watch the video](https://img.youtube.com/vi/mXfAUXayi54/maxresdefault.jpg)](https://youtu.be/mXfAUXayi54)

In [*Minority Report*](https://www.imdb.com/title/tt0181689/), when one precog sees it differently, the dissent is
quietly thrown away. Here it gets argued out: nothing is outvoted, and a challenge nobody answered stays on the record
as the finding's minority report. It's a hearing, not a vote.

## Install

You need [Mirador](https://github.com/sodre90/mirador) with plugin API 8, and [Bun](https://bun.sh).

```bash
git clone https://github.com/akanto/spectra-council.git && cd spectra-council
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/spectra-council
```

Restart Mirador. Each [release](https://github.com/akanto/spectra-council/releases) also has a tarball with
`plugin.json` and the built view.

## Using it

Ask Mirador's agent: *"Convene a Spectra Council review of this repo."* The review opens in the canvas, beside the chat.

- **Set it up**: a repository, a folder or one document; what to look for (general, code, architecture, security or
  science); how deep (Quick, Standard, Deep); and up to eight seats, each one of your Mirador profiles, on its own
  model and effort or one you pick for the seat.
- **Investigate**: each reviewer works alone, without seeing the others, and reports findings with evidence: a file, a
  line, a quote. When two find the same problem on their own, the council says so.
- **Deliberate**: over a few rounds the reviewers back, challenge or doubt each finding, citing the code. Watch it live,
  or open any reviewer's own conversation.
- **Verdict**: each finding ends **agreed**, **confirmed**, **disputed** or **withdrawn**. A disputed one shows its
  minority report first: who still challenges it, and why.
- **Rule**: Accept, Dismiss or Later, each with an optional note.
- **Fix**: *Ask agent to fix* hands the accepted findings to your agent (or another profile) with a hand-off: the
  evidence, the argument, any dissent and a proposed fix. *Re-check fixes* has the reviewers verify the work or reopen
  it.

A strip above the tabs shows where the review stands: each step done, current, skipped or stopped, with live progress on
the current one. It is read-only; ✕ hides it, and the phase pill in the header brings it back.

To try it without spending tokens, ask for a mock review: stand-in reviewers that play the whole flow.

## Advanced

- **Tickets**: in a [beads](https://github.com/gastownhall/beads) workspace, the agent can file one issue per accepted
  finding. Or send your own instruction with the findings ("fix only the security ones, and add tests").
- **The fixer**: choose another profile as the **Spectra Council fixer** in the conversation header, and the fixes run
  in a conversation of its own.
- **Slow reviewers**: a reviewer's turn gives up after 15 minutes. Choose a longer **Spectra Council turn limit** in
  the conversation header for slow models.
- **Restarts**: reviews are Mirador canvas items. One that was running when Mirador stopped can be resumed, and it picks
  up the reviewer conversations still running.
- **Safety**: reviewers are told to only read the target. They run with your chat's permission mode, on the model and
  effort picked for their seat (by default, their profile's).
- **Settings**: in Mirador's settings for the plugin, **Open reviews** opens a review beside the chat or full screen.

Your agent hears how a review ended with your next message, and can read every finding with `council_status`.

### Building from source

See [docs/development.md](docs/development.md) for the commands, the layout and how the engine works. The video is
made by `video/` (see [video/README.md](video/README.md)).

## License

MIT
