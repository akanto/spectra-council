# Spectra Council

**Several AI agents review your work. They disagree, argue it out, and you get a verdict backed by evidence.**

<!-- Demo video goes here. -->

In [*Minority Report*](https://www.imdb.com/title/tt0181689/), three precogs foresee every crime. When one of them sees
it differently, that dissent, the minority report, is quietly thrown away and the system goes with the majority.

Spectra Council does the opposite: the dissent gets argued out, not outvoted. It's a hearing, not a vote.

## How it works

1. **Convene.** Point it at a repository, a folder or a single document. Pick what to look for (general, code,
   architecture, security or science) and seat up to eight reviewers, each an agent on one of your Mirador profiles:
   Claude, Codex, Gemini, Qwen, or any model a profile runs.
2. **Investigate.** Each reviewer works on its own, without seeing the others, and reports findings with evidence: a
   file, a line, a quote.
3. **Deliberate.** The findings go on the table. Over a few rounds the reviewers back them, challenge them or say they
   can't tell, and every argument has to point at evidence.
4. **Verdict.** Each finding is settled as **agreed**, **confirmed**, **disputed** or **withdrawn**. A challenge that was
   never answered stays on the record as the finding's minority report.
5. **Act.** You accept, dismiss or defer each finding. The accepted ones go to an agent with a hand-off file: the
   evidence, how the council reached its conclusion, any dissent, and a proposed fix. When the fixes are in, the council
   re-checks them.

## What you get

- **A live workspace.** One panel per reviewer with what it's doing now; open one for its full activity, or open the
  reviewer's own Mirador conversation to read everything it did.
- **The council.** Every finding with each reviewer's stance, the argument round by round, and how it was settled.
- **Findings.** Sorted by severity and filterable by reviewer, severity and status. Click a path to open the file.
- **Rulings and a hand-off.** Accept, Dismiss or Later, each with an optional note. The hand-off is written to
  `<target>/.spectra-council/review-<id>.md`.
- **Fixes, by any agent.** Your conversation's agent fixes the accepted findings, or another profile does (pi on a
  different model, say), in a conversation of its own. Each fix shows on its finding, and a re-check marks it verified
  or reopens it.
- **Tickets or your own words.** In a [beads](https://github.com/gastownhall/beads) workspace, have the agent file one
  issue per accepted finding. Or write your own instruction ("fix only the security ones and add tests") and send it
  with the findings.
- **It survives restarts.** Reviews are Mirador canvas items. A review that was running when Mirador stopped can be
  resumed, and it picks up the reviewer conversations that were still running.

## Install

You need [Mirador](https://github.com/sodre90/mirador) with plugin API 5, and [Bun](https://bun.sh) to build from source.

```bash
git clone https://github.com/akanto/spectra-council.git && cd spectra-council
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/spectra-council
```

Restart Mirador. Each [release](https://github.com/akanto/spectra-council/releases) also has a tarball with
`plugin.json` and the built view.

## Use it

Ask Mirador's agent: *"Convene a Spectra Council review of this repo."* It opens a review in the canvas, beside the chat.
To review something narrower, like one document or folder, say so. To try it without spending tokens, ask for a mock
review: deterministic stand-in reviewers that play the whole flow.

1. **Set it up.** Choose the profile, the depth and the seats, and add instructions if you like. Quick runs 2 rounds
   with at most 3 findings per reviewer, Standard 3 and 6, Deep 4 and 10; Custom sets both yourself. A seat is one of
   your Mirador profiles, named as Mirador names it ("Home", "pi home"). Then **Start review**.
2. **Watch.** The Workspace tab shows the reviewers at work. Each turn of a reviewer opens a conversation under yours in
   the sidebar. **Stop** ends the review.
3. **Read the verdict.** The Council tab leads with a one-line verdict. Select a finding for its positions, its
   arguments and its proposed fix. A disputed finding shows its minority report first: who still challenges it, and why.
4. **Rule.** Mark each finding Accept, Dismiss or Later.
5. **Fix.** *Ask agent to fix* hands the accepted findings to your conversation's agent, most severe first. To use
   another profile, choose it as the **Spectra Council fixer** in the conversation header. The button then says
   *Ask &lt;profile&gt; to fix*.
6. **Re-check.** *Re-check fixes* has each fixed finding's reporter and backers check the fix. A reopened finding can be
   handed off again, with the reviewers' feedback in the hand-off.

Your agent hears how the review ended with your next message, and can read every finding with `council_status`.

Reviewers are told to only read the target. They run with your chat's permission mode, and on each profile's own model
and effort.

**Settings.** In Mirador's settings for the plugin, **Open reviews** chooses whether a review opens beside the chat or
full screen. The fixer is a per-conversation setting, in the conversation header.

## Contributing

See [docs/development.md](docs/development.md) for the commands, the layout and how the engine works.

## License

MIT
