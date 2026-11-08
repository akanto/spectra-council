/**
 * Cuts the video from the take (capture.ts), the cards (cards.ts) and the narration (narrate.ts), as NeoManuscript's
 * video is cut. Each shot is a stretch of the take between two of its moments, played at the length the shot is given,
 * with the camera easing between views of the window; shots from the take cut into each other, cards cross-fade.
 * render.py draws the frames; ffmpeg lays the narration under them. `bun video/lib/edit.ts` writes
 * video/out/spectra-council.mp4.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LINES, type LineName } from "./lines.ts";

const out = join(import.meta.dir, "..", "out");
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
/** The takes' frames are the window's CSS pixels times this. */
const SCALE = 5 / 3;
const CSS = { width: 1536, height: 864 };

interface Take {
  dir: string;
  frames: { t: number; file: string }[];
  moments: { name: string; at: number }[];
}

function take(name: string): Take {
  const dir = join(out, name);
  return {
    dir,
    frames: JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")),
    moments: JSON.parse(readFileSync(join(dir, "moments.json"), "utf8")),
  };
}

/** A moment of a take, in seconds; the nth of that name, or the last with nth -1. */
function moment(source: Take, name: string, nth = 0): number {
  const all = source.moments.filter((m) => m.name === name);
  const found = nth < 0 ? all.at(nth) : all[nth];
  if (!found) throw new Error(`no moment "${name}" in ${source.dir}`);
  return found.at;
}

/** Part of the window to show: its centre and width in CSS pixels; the height follows at 16:9. */
type View = { cx: number; cy: number; w: number };
const FULL: View = { cx: CSS.width / 2, cy: CSS.height / 2, w: CSS.width };

interface Shot {
  /** A take's stretch, or a card. */
  source: { take: Take; from: number; to: number } | { still: string };
  seconds: number;
  /** Views the camera eases to, at seconds into the shot. */
  camera?: { at: number; view: View; ease?: number }[];
  /** Narration lines, at seconds into the shot. */
  say?: { at: number; line: LineName }[];
}

const FADE = 0.6;

function viewAt(shot: Shot, at: number): View {
  let view = shot.camera?.[0]?.at === 0 ? shot.camera[0].view : FULL;
  for (const key of shot.camera ?? []) {
    if (at < key.at) break;
    const ease = key.ease ?? 1;
    const p = Math.min(1, (at - key.at) / ease);
    const s = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    view = { cx: view.cx + (key.view.cx - view.cx) * s, cy: view.cy + (key.view.cy - view.cy) * s, w: view.w + (key.view.w - view.w) * s };
  }
  return view;
}

/** The view as a crop of the frame, in its pixels, kept inside the frame. */
function rect(view: View): [number, number, number, number] {
  const w = Math.min(CSS.width, view.w);
  const h = (w * 9) / 16;
  const x = Math.max(0, Math.min(CSS.width - w, view.cx - w / 2));
  const y = Math.max(0, Math.min(CSS.height - h, view.cy - h / 2));
  return [x * SCALE, y * SCALE, w * SCALE, h * SCALE];
}

function frameAt(shot: Shot, at: number): string {
  if ("still" in shot.source) return shot.source.still;
  const { take: source, from, to } = shot.source;
  const t = from + ((to - from) * at) / shot.seconds;
  let lo = 0;
  let hi = source.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (source.frames[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return join(source.dir, "frames", source.frames[lo]!.file);
}

// --- The cut -----------------------------------------------------------------------------------------------------------

const capture = take("capture");
const c = (name: string, nth = 0) => moment(capture, name, nth);
const stretch = (from: number, to: number) => ({ take: capture, from, to });

// The camera has three framings, each aligned to the edges of what it frames, so no panel is ever cut through the
// middle: the whole window; the canvas panel (x 563 to the window's right edge, from just under its title bar); and,
// to read an argument thread, the selected finding's column on the canvas's right. Every section opens on the whole
// window or on a framing it already showed, and the camera moves only when the action moves, easing over about 2 s.
const PANEL_LEFT = 563;
const PANEL: View = { cx: (PANEL_LEFT + CSS.width) / 2, cy: 44 + ((CSS.width - PANEL_LEFT) * 9) / 32, w: CSS.width - PANEL_LEFT };
const THREAD_W = 620;
const THREAD: View = { cx: CSS.width - THREAD_W / 2, cy: 824 - (THREAD_W * 9) / 32, w: THREAD_W };
const EASE = 2;

/** A shot of the take from one moment to another, played in `seconds`. */
const part = (from: number, to: number, seconds: number, rest: Omit<Shot, "source" | "seconds"> = {}): Shot => ({ source: stretch(from, to), seconds, ...rest });

const shots: Shot[] = [
  { source: { still: join(out, "cards", "title.jpg") }, seconds: 8.4, say: [{ at: 0.5, line: "intro" }] },
  // The whole window: the person asks, the agent opens the review beside the chat with four seats.
  part(c("open typing") - 0.6, c("seated") + 1.2, 10.6, { camera: [{ at: 0, view: FULL }], say: [{ at: 0.4, line: "ask" }] }),
  // Start: still the whole window, so the click lands where the viewer already looks.
  part(c("seated") + 1.2, c("started") + 1, 2.4, { camera: [{ at: 0, view: FULL }] }),
  // The review runs: into the canvas panel, and the camera stays there.
  part(c("started") + 1, c("deliberation"), 9, {
    camera: [{ at: 0, view: FULL }, { at: 0.8, view: PANEL, ease: EASE }],
    say: [{ at: 0.4, line: "independent" }],
  }),
  part(c("deliberation"), c("race arguments"), 6.5, { camera: [{ at: 0, view: PANEL }], say: [{ at: 0.3, line: "twice" }] }),
  // The race: closer, to read the challenge, the answer and the concession; then back to the panel for the verdict.
  part(c("race arguments"), c("verdict"), 15, {
    camera: [{ at: 0, view: PANEL }, { at: 1.2, view: THREAD, ease: EASE }, { at: 13, view: PANEL, ease: EASE }],
    say: [{ at: 0.2, line: "deliberate" }, { at: 7.8, line: "race" }],
  }),
  part(c("verdict"), c("ruling"), 7.4, { camera: [{ at: 0, view: PANEL }], say: [{ at: 0.4, line: "verdict" }] }),
  part(c("ruling"), c("fix asked") + 1, 5.6, { camera: [{ at: 0, view: PANEL }], say: [{ at: 0.4, line: "rule" }] }),
  // The agent fixes in the chat: out to the whole window.
  part(c("fix asked") + 1, c("fix done") + 0.5, 7, { camera: [{ at: 0, view: PANEL }, { at: 0.2, view: FULL, ease: EASE }] }),
  // The re-check: back into the panel, and held on the verified fixes.
  part(c("review back") - 0.3, c("rechecked") + 0.6, 6.4, {
    camera: [{ at: 0, view: FULL }, { at: 0.6, view: PANEL, ease: EASE }],
    say: [{ at: 0.8, line: "recheck" }],
  }),
  part(c("rechecked") + 0.6, c("rechecked") + 4.6, 4.2, { camera: [{ at: 0, view: PANEL }] }),
  { source: { still: join(out, "cards", "end.jpg") }, seconds: 6, say: [{ at: 0.6, line: "end" }] },
];

// --- Frames ------------------------------------------------------------------------------------------------------------

/** A shot cross-fades in from another take or a card; one going on in the same take cuts straight in. */
const fadeIn = (index: number) => {
  const shot = shots[index]!;
  const before = shots[index - 1];
  if (!before) return 0;
  const sameTake = "take" in shot.source && "take" in before.source && shot.source.take === before.source.take;
  return sameTake ? 0 : FADE;
};
const starts: number[] = [];
let clock = 0;
for (const [i, shot] of shots.entries()) {
  starts.push(clock);
  clock += shot.seconds - (i < shots.length - 1 ? fadeIn(i + 1) : 0);
}
const total = clock;

const frames = [];
for (let i = 0; i < Math.round(total * FPS); i++) {
  const t = i / FPS;
  const layers = [];
  for (const [index, shot] of shots.entries()) {
    const at = t - starts[index]!;
    if (at < 0 || at >= shot.seconds) continue;
    const fade = fadeIn(index);
    layers.push({ src: frameAt(shot, at), rect: "still" in shot.source ? [0, 0, CSS.width * SCALE, CSS.height * SCALE] : rect(viewAt(shot, at)), alpha: fade && at < fade ? at / fade : 1 });
  }
  const black = Math.max(0, 1 - t / 0.5, (t - (total - 0.8)) / 0.8);
  frames.push({ layers, black: Math.min(1, black) });
}
const plan = join(tmpdir(), `spectra-council-plan-${process.pid}.json`);
writeFileSync(plan, JSON.stringify({ fps: FPS, width: WIDTH, height: HEIGHT, frames }));

// --- Narration ---------------------------------------------------------------------------------------------------------

const lengths = JSON.parse(readFileSync(join(out, "narration", "manifest.json"), "utf8")).seconds as Record<LineName, number>;
const cues = shots
  .flatMap((shot, index) => (shot.say ?? []).map(({ at, line }) => ({ line, at: starts[index]! + at })))
  .sort((a, b) => a.at - b.at);
let free = 0;
for (const cue of cues) {
  if (cue.at < free + 0.2) {
    console.warn(`"${cue.line}" would start ${(free + 0.2 - cue.at).toFixed(2)} s into the line before; moved`);
    cue.at = free + 0.2;
  }
  free = cue.at + lengths[cue.line];
}
console.log(cues.map((cue) => `${cue.at.toFixed(1).padStart(5)}  ${cue.line}: ${LINES[cue.line]}`).join("\n"));
console.log(`total ${total.toFixed(1)} s; narration ends at ${free.toFixed(1)} s`);

// --- Render ------------------------------------------------------------------------------------------------------------

const silent = join(out, "picture.mp4");
const python = join(homedir(), ".cache", "mirador-video", "venv", "bin", "python");
const render = Bun.spawnSync([python, "-I", join(import.meta.dir, "render.py"), plan, silent], { stdout: "inherit", stderr: "inherit", cwd: tmpdir() });
if (render.exitCode !== 0) throw new Error("render failed");

const inputs = cues.flatMap((cue) => ["-i", join(out, "narration", `${cue.line}.wav`)]);
const delays = cues.map((cue, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(cue.at * 1000)}:all=1[a${i}]`);
const mix = `${delays.join(";")};${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[voice]`;
const final = join(out, "spectra-council.mp4");
const mux = Bun.spawnSync(
  ["ffmpeg", "-y", "-loglevel", "error", "-i", silent, ...inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", final],
  { stdout: "inherit", stderr: "inherit" },
);
if (mux.exitCode !== 0) throw new Error("ffmpeg failed");
rmSync(silent);
rmSync(plan);
console.log("wrote", final);
