/**
 * Speaks the narration with Kokoro, the open-weight voice model the Mirador trailer uses, on this machine, into
 * video/out/narration, with each line's length in manifest.json. Needs the model in ~/.cache/mirador-video/kokoro-v1.0
 * and a Python with kokoro-onnx and soundfile in ~/.cache/mirador-video/venv.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LINES, SPEED, VOICE } from "./lines.ts";

const cache = join(homedir(), ".cache", "mirador-video");
const out = join(import.meta.dir, "..", "out", "narration");
mkdirSync(out, { recursive: true });

const jobs = Object.entries(LINES).map(([name, text]) => ({ text, voice: VOICE, speed: SPEED, out: join(out, `${name}.wav`) }));
const jobsFile = join(tmpdir(), `council-narration-${process.pid}.json`);
writeFileSync(jobsFile, JSON.stringify(jobs));
const speak = Bun.spawnSync(
  [join(cache, "venv", "bin", "python"), "-I", join(import.meta.dir, "speak.py"), join(cache, "kokoro-v1.0", "kokoro-v1.0.onnx"), join(cache, "kokoro-v1.0", "voices-v1.0.bin"), jobsFile],
  { cwd: tmpdir(), stderr: "inherit" },
);
if (speak.exitCode !== 0) throw new Error("Kokoro failed");
const seconds = Object.fromEntries(
  speak.stdout.toString().trim().split("\n").map((line) => {
    const { out: file, seconds } = JSON.parse(line) as { out: string; seconds: number };
    return [file.split("/").at(-1)!.replace(".wav", ""), seconds];
  }),
);
writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ voice: VOICE, seconds }, null, 2)}\n`);
console.log(seconds);
