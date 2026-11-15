# Research councils

Status: built, on the `research-councils` branch. Where the code does something other than the text below, the text
says so.

A research council is the second kind of council, beside the review. The seats research a brief on their own, check
each other's sources, argue the claims out, and an editor writes **one consolidated answer**, so the user reads one
document instead of one report per seat.

Example brief: a Markdown file that states the research questions in priority order, where to look, rules for sources,
and the deliverable's shape and path (a literature search for published medical-imaging query workloads, say).

## Decisions

1. **One plugin, two kinds.** A session has a `kind`: `review` or `research`. They share seats, the runner (a fresh
   conversation per turn, a JSON reply), the rounds, settlement and the process strip. They differ in prompts, the unit
   argued over, the end product and what follows the verdict (research has no fix loop).
2. **Input: a brief file and a workspace.** The brief is a path; the workspace (by default the folder the
   conversation works in) is readable context, since a brief may point at files in it. A question typed in the setup is
   saved as a brief file when the council starts, at `<workspace>/.spectra-council/research-<id>-brief.md`, so every run
   has one on disk.
3. **Redundant research.** Every seat researches the whole brief alone, as reviewers review alone. The setup may give a
   seat an optional focus (an RQ, a set of venues) to reduce overlap.
4. **The unit is a claim.** A claim is atomic and has a kind:
   - `fact`: a published fact, with sources;
   - `inference`: the researcher's own reasoning, kept apart from facts;
   - `gap`: what was searched for and not found.

   It is tagged with the brief's research question it answers. A source has a DOI or stable URL, authors, title, venue
   and year, the supporting quote with a page or section, and whether the researcher read the `full-text` or only the
   `abstract`.
5. **Brief-defined fields.** A claim may carry free key/value `fields` the brief asks for (a DICOM level, projection,
   selectivity). Each field can be challenged on its own, and the answer's tables are built from fields, not re-read
   from prose. No declared schema for now.
6. **Assigned source check before the rounds.** After the claims are merged (a grouping turn: the same source and point
   reported by two seats is one claim, corroborated), every claim's sources go to at least one seat that didn't report
   it, preferring a seat on another model. That seat opens each source and records `verified`, `quote-not-found`,
   `doesnt-support`, `unreachable` or `paywalled`. The back/challenge rounds then run with those checks on the record.
   The check runs at round 0 of the deliberation, after the grouping turn. Only a real agent takes the grouping turn;
   with mock seats alone, the check runs on the claims as reported.
7. **Settlement.** As for findings (agreed, confirmed, disputed, withdrawn), plus `unverified`: a `fact` claim none of
   whose sources passed the check. It stays in the ledger with its failed checks, and the answer may list it only among
   the leads. `inference` and `gap` claims settle by stance alone. A run with no rounds checks nothing and settles
   nothing: its claims stay `reported`.
8. **The answer: an editor's narrative and the plugin's ledger.** The editor writes the document in the brief's
   deliverable format, from standing claims only, citing them by id (`[C12]`). A disputed claim appears only with its
   dissent. The plugin rejects a draft that cites an id that doesn't exist or doesn't stand, and appends the ledger:
   every claim, its status, its source checks and any minority report. The answer is drafted in the synthesis phase,
   after the claims are settled.
9. **The editor** is one of the council's seats, not a profile of its own: the setup picks one (`editor`, `r1` by
   default). It researches like the others, and it is the seat that drafts and revises the answer. If it has failed,
   the first seat still at the council writes it.
10. **One check of the draft.** Every other seat still at the council reads the draft against the ledger and reports
    concrete misstatements (sentence, claim id, what's wrong). With any, the editor revises once; objections left after
    that are printed at the top of the answer as the council's objections to the text. No second loop.
11. **Read-only agents; the plugin writes.** Researchers, checkers and the editor change no file. The editor returns
    the Markdown in its JSON reply and the plugin writes the answer file, again after each revision, so the file always
    matches the canvas's **Answer** tab (the first tab once a run ends).
12. **The answer file** is a setup field. The agent fills it in `council_open` when the brief names a path; otherwise it
    is `<brief name>-answer.md` beside the brief.
13. **Follow-ups.** After the answer, the user can send the council back with a question ("RQ2 came back thin: look at
    RSNA informatics 2018 to 2025"). The seats that completed research research it as a new run, with the ledger handed
    to them as known. New claims go through the source check and rounds, and the editor revises the same answer. One
    session, one growing ledger, one answer. A research council doesn't reopen; a finished one is sent back with a
    follow-up instead.
14. **Rulings on claims.** The user keeps or strikes a claim (`kept` or `struck`), with an optional note. Rulings are
    recorded, and the answer is not rewritten by them: the user presses **Revise answer**, which has the editor write
    the answer again without the struck claims. A struck claim stays in the ledger, marked struck. Several rulings take
    one revision, not one each. The first answer doesn't wait for rulings.
15. **Turn limits.** A seat's own research may take 60 minutes; the source check, a round, a draft and a check take 20
    minutes each. A profile's Spectra Council turn limit still overrides both.
16. **Web access.** Researchers need web search and fetch, which the plugin can't see in a profile. The setup says so,
    and the research reply carries `webAccess`; a seat that reports `false` fails with that reason rather than
    returning thin results.
17. **Depth.** Quick, Standard, Deep: 1, 2, 3 rounds and 15, 30, 60 claims per seat (the claims knob goes to 100).
    Rounds are fewer than a review's because the source check does the heavy verification.
18. **Late replies.** A research seat's late reply can't be fetched: "Fetch its reply" is not offered for it. Send a
    follow-up instead; the seats that completed their research take it up.

## Flow

Setup → Research → Merge → Source check → Deliberate → Settle → Answer (draft, check, revise) → Follow-up or
ruling, which loops back and revises the answer in place.

The process strip's steps for a research council: Setup, Research, Check sources, Deliberate, Answer, Follow-up. The
Check sources step shows only at round 0 while the check is still to run. A council with fewer than two seats done, or
with no claims, skips the check and the rounds: the claims stay `reported`, and the editor still writes the answer.

## Engine shape

- `Review` gains `kind` (reviews stored before read as `review`; `REVIEW_FORMAT` 8 → 9) and an optional `research` part:
  the brief's path, the answer file, the editor seat, each draft with its check and revision, and the follow-ups.
- `Claim` is a type of its own (id `C<n>`, rq, kind, text, fields, sources with their checks), not a stretched
  `Finding`, so the review's findings and fix loop stay as they are. It reuses `Position`, `Argument`, `Resolution` and
  `settle`, extended for `unverified`.
- New events with reducer cases and tests, as every behaviour change: claims reported and merged, sources assigned and
  checked, draft written, draft checked, draft revised, answer written, follow-up asked, claim ruled.
- `council_open` takes `kind`, `brief`, `question`, `answerFile` and `editor`. Mock researchers stay deterministic, for
  the harness, the e2e tests and the demo.
