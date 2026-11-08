// Cuts a release: `bun run release 0.2.0` sets the version in package.json and plugin.json, commits them as
// "Release v0.2.0" and tags v0.2.0 (annotated). It does not push: it prints the command.
import { join } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const FILES = ["package.json", "plugin.json"];

/** The environment for git, without what a git hook sets, so `cwd` is the repository git acts on. */
function gitEnv(): Record<string, string | undefined> {
  const { GIT_DIR: _d, GIT_INDEX_FILE: _i, GIT_WORK_TREE: _w, ...env } = process.env;
  return env;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  return out;
}

/** Replaces the top-level "version" value, leaving every other byte of the file as it was. */
function setVersion(text: string, version: string, file: string): string {
  const re = /^(  "version": ")[^"]*(")/m;
  if (!re.test(text)) throw new Error(`${file}: no top-level "version" line to update`);
  return text.replace(re, `$1${version}$2`);
}

export async function release(version: string, cwd: string): Promise<void> {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 0.2.0 (no leading v)`);
  if ((await git(cwd, "status", "--porcelain")).trim() !== "") throw new Error("the git tree is dirty: commit or stash first");
  const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (branch !== "main") throw new Error(`on branch "${branch}": releases are cut from main`);
  const tag = `v${version}`;
  if ((await git(cwd, "tag", "--list", tag)).trim() !== "") throw new Error(`tag ${tag} already exists`);
  // With a remote: main must not be behind it, and the tag mustn't be there already, or the push would split.
  if ((await git(cwd, "remote")).split("\n").includes("origin")) {
    await git(cwd, "fetch", "--quiet", "origin", "main");
    const behind = Number((await git(cwd, "rev-list", "--count", "HEAD..origin/main")).trim());
    if (behind > 0) throw new Error(`main is ${behind} commit${behind === 1 ? "" : "s"} behind origin/main: pull first`);
    if ((await git(cwd, "ls-remote", "--tags", "origin", tag)).trim() !== "") throw new Error(`tag ${tag} already exists on origin`);
  }

  const originals: Record<string, string> = {};
  const updated: Record<string, string> = {};
  for (const f of FILES) {
    originals[f] = await Bun.file(join(cwd, f)).text();
    updated[f] = setVersion(originals[f]!, version, f);
  }
  for (const f of FILES) await Bun.write(join(cwd, f), updated[f]!);

  try {
    await git(cwd, "add", ...FILES);
    await git(cwd, "commit", "-m", `Release ${tag}`);
  } catch (error) {
    // Nothing committed: put the files back as they were, so the release can simply be run again.
    await git(cwd, "reset", "--quiet", "--", ...FILES).catch(() => {});
    for (const f of FILES) await Bun.write(join(cwd, f), originals[f]!);
    throw error;
  }
  try {
    await git(cwd, "tag", "-a", tag, "-m", `Release ${tag}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`committed "Release ${tag}" but couldn't tag it (${reason}). Tag it with:\n  git tag -a ${tag} -m "Release ${tag}"`);
  }
  console.log(`Released ${tag}. Push both at once with:\n  git push --atomic origin main ${tag}`);
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun run release <version>   (for example 0.2.0)");
    process.exit(1);
  }
  try {
    await release(version, process.cwd());
  } catch (e) {
    console.error(`release failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
