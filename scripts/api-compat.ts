/**
 * Checks that hosts/mirador/api.ts, our copy of Mirador's plugin API, still fits Mirador's own types: typechecks
 * compat/mirador-api.ts against a Mirador shared/ folder. Which one: $MIRADOR_SHARED, else .mirador/shared (CI's
 * pinned checkout), else the installed app's. Without any, it says so and passes, unless $MIRADOR_SHARED is set.
 *
 *   bun run api-compat
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = join(import.meta.dir, "..");
const wanted = process.env.MIRADOR_SHARED;
const candidates = wanted ? [resolve(wanted)] : [join(repo, ".mirador", "shared"), join(homedir(), "Applications/Mirador.app/Contents/Resources/app/mirador/shared")];
const shared = candidates.find((dir) => existsSync(join(dir, "canvas-plugins.ts")));
if (!shared) {
  if (wanted) {
    console.error(`No Mirador shared/ folder at ${wanted} (MIRADOR_SHARED).`);
    process.exit(1);
  }
  console.log("No Mirador checkout or installed app found; skipping the plugin API check.");
  process.exit(0);
}

// tsc reads paths from a config file, so one is written next to the check (gitignored).
const config = join(repo, "compat", "tsconfig.local.json");
await Bun.write(
  config,
  `${JSON.stringify({ extends: "../tsconfig.json", compilerOptions: { paths: { "mirador-shared/*": [`${shared}/*`] } }, include: [], files: ["mirador-api.ts", "externals.d.ts"] }, null, 2)}\n`,
);
console.log(`Checking hosts/mirador/api.ts against ${shared}`);
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", config], { cwd: repo, stdout: "pipe", stderr: "pipe" });
if (tsc.exitCode !== 0) {
  const output = `${tsc.stdout.toString()}${tsc.stderr.toString()}`;
  console.error(output.trimEnd());
  // An error in the check itself is a disagreement; one only in Mirador's files means its code didn't typecheck here.
  const ours = output.split("\n").some((line) => /^(compat|hosts)\//.test(line));
  console.error(
    ours
      ? "hosts/mirador/api.ts no longer fits Mirador's plugin API: see the errors above."
      : "Mirador's own files didn't typecheck here (a file missing from the checkout, or code our compiler options reject); the check couldn't run.",
  );
  process.exit(1);
}
console.log("hosts/mirador/api.ts fits Mirador's plugin API.");
