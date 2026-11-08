# The video

The promo video in the README, made from a real take: a throwaway Mirador (the e2e `TestHost` of a Mirador checkout
at `../../sodre90/mirador`) on your Claude login, with this plugin linked in. The chat turn that opens the review and
the agent that fixes the accepted findings are real Claude turns (Sonnet). The four reviewers play a script
(`lib/script.ts`) about the demo shop in `demo/tinyshop`, whose planted problems they find, argue over and re-check, so
a take costs a few cents and takes a few minutes, not a real four-agent review.

```bash
bun run build                 # the view the take loads
bun video/lib/capture.ts      # the take: video/out/capture
bun video/lib/cards.ts        # title and end cards, thumbnail: video/out/cards
bun video/lib/narrate.ts      # the narration: video/out/narration
bun video/lib/edit.ts         # the cut: video/out/spectra-council.mp4
```

The narration is spoken by [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (voice `af_heart`, as NeoManuscript's
video): it needs the model in `~/.cache/mirador-video/kokoro-v1.0` and a Python with `kokoro-onnx`, `soundfile` and
`Pillow` in `~/.cache/mirador-video/venv`. The edit needs `ffmpeg`.

- `lib/script.ts`: what each reviewer reads, finds and argues, round by round, and its fixes and re-checks.
- `lib/scripted-runner.ts`: plays the script as a `ReviewerRunner`; `lib/plugin-host.ts` is the plugin host that uses
  it (through `createCouncilHost`'s `runnerFor`).
- `lib/lines.ts`: the narration. `lib/edit.ts`: the shots, camera and where each line falls.
