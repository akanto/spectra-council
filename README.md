# Spectra Council

**Several AI agents review your work. They disagree, argue it out, and you get a verdict backed by evidence.**

<!-- Demo video goes here. -->

In *Minority Report*, three precogs foresee every crime. When one of them sees it differently, that dissent, the
minority report, is quietly thrown away and the system goes with the majority.

Spectra Council does the opposite: the dissent gets argued out, not outvoted.

## How it works

1. **Convene.** Point it at a repository, a paper or a folder. Pick what to look for (code, architecture, security,
   science) and seat up to four agents: Claude, Codex, Gemini, Qwen.
2. **Investigate.** Each agent reviews on its own, without seeing the others. You watch them read, search and report
   findings live.
3. **Deliberate.** The findings go on the table without names. Agents back them, challenge them, or ask for proof, and
   every claim has to point at a file, a line, a quote.
4. **Verdict.** Each finding ends up confirmed, disputed or withdrawn, with its evidence and any dissent kept on the
   record.
5. **Act.** You rule on each finding: accept it, dismiss it or leave it for later. The accepted ones go to your agent as
   a hand-off with the council's reasoning and a proposed fix. The agent fixes them, and the council checks the fixes.

It's a hearing, not a vote.

## Where it stands

Early days. Seats can now be real agents on your Mirador profiles, or mocks for demos. You set up a review, watch four seats
work, browse the findings, read them argued out to a verdict, then rule on the findings and see the fixes re-checked.
The [roadmap](docs/architecture.md) has the details.

## Try it

Spectra Council runs inside [Mirador](https://github.com/sodre90/mirador), as a plugin.

```bash
git clone https://github.com/akanto/spectra-council.git && cd spectra-council
bun install && bun run build
ln -s "$PWD" ~/.mirador/plugins/spectra-council
```

Restart Mirador and ask its agent: *"Convene a Spectra Council review of this repo."*

Building on it? See [docs/development.md](docs/development.md).

MIT licensed.
