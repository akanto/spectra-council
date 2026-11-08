import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release } from "../scripts/release.ts";

let dir: string;

async function git(...args: string[]): Promise<string> {
  // Without a git hook's GIT_DIR and the like, so git acts on the temp repository.
  const { GIT_DIR: _d, GIT_INDEX_FILE: _i, GIT_WORK_TREE: _w, ...env } = process.env;
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
}

const pkg = (v: string) => `{\n  "name": "x",\n  "version": "${v}",\n  "private": true\n}\n`;
const plug = (v: string) => `{\n  "name": "x",\n  "version": "${v}",\n  "api": 5\n}\n`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "release-"));
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("config", "commit.gpgsign", "false");
  await git("config", "tag.gpgsign", "false");
  await Bun.write(join(dir, "package.json"), pkg("0.1.0"));
  await Bun.write(join(dir, "plugin.json"), plug("0.1.0"));
  await git("add", ".");
  await git("commit", "-m", "init");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function untouched() {
  expect(await Bun.file(join(dir, "package.json")).text()).toBe(pkg("0.1.0"));
  expect(await Bun.file(join(dir, "plugin.json")).text()).toBe(plug("0.1.0"));
  expect((await git("log", "--format=%s")).trim()).toBe("init");
  expect((await git("tag", "--list")).trim()).toBe("");
}

test("bumps both files, commits and tags", async () => {
  await release("0.2.0", dir);
  expect(await Bun.file(join(dir, "package.json")).text()).toBe(pkg("0.2.0"));
  expect(await Bun.file(join(dir, "plugin.json")).text()).toBe(plug("0.2.0"));
  expect((await git("log", "-1", "--format=%B")).trim()).toBe("Release v0.2.0");
  expect((await git("tag", "--list")).trim()).toBe("v0.2.0");
  expect((await git("cat-file", "-t", "v0.2.0")).trim()).toBe("tag");
  expect((await git("tag", "-l", "--format=%(contents)", "v0.2.0")).trim()).toBe("Release v0.2.0");
  expect((await git("status", "--porcelain")).trim()).toBe("");
});

test("refuses a dirty tree", async () => {
  await Bun.write(join(dir, "extra.txt"), "x");
  await expect(release("0.2.0", dir)).rejects.toThrow(/dirty/);
  await Bun.file(join(dir, "extra.txt")).delete();
  await untouched();
});

test("refuses a branch other than main", async () => {
  await git("checkout", "-b", "feature");
  await expect(release("0.2.0", dir)).rejects.toThrow(/main/);
  await untouched();
});

test("refuses an existing tag", async () => {
  await git("tag", "v0.2.0");
  await expect(release("0.2.0", dir)).rejects.toThrow(/already exists/);
  expect(await Bun.file(join(dir, "package.json")).text()).toBe(pkg("0.1.0"));
  expect((await git("log", "--format=%s")).trim()).toBe("init");
});

test("refuses a bad version", async () => {
  for (const v of ["v0.2.0", "0.2", "latest", ""]) await expect(release(v, dir)).rejects.toThrow(/version/);
  await untouched();
});

test("a commit that fails leaves both files as they were, so it can be run again", async () => {
  const hooks = join(dir, ".hooks");
  await Bun.write(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  await Bun.spawn(["chmod", "+x", join(hooks, "pre-commit")]).exited;
  await git("config", "core.hooksPath", hooks);
  await Bun.write(join(dir, ".git", "info", "exclude"), ".hooks/\n");
  await expect(release("0.2.0", dir)).rejects.toThrow();
  await untouched();
  expect((await git("status", "--porcelain")).trim()).toBe("");
});

test("refuses a tag that already exists on origin, and a main behind origin's", async () => {
  const origin = await mkdtemp(join(tmpdir(), "release-origin-"));
  try {
    await Bun.spawn(["git", "init", "--bare", "-b", "main", origin]).exited;
    await git("remote", "add", "origin", origin);
    await git("tag", "v0.2.0");
    await git("push", "-q", "origin", "main", "v0.2.0");
    await git("tag", "-d", "v0.2.0");
    await expect(release("0.2.0", dir)).rejects.toThrow(/already exists on origin/);
    // origin's main moves on; ours stays behind.
    await git("commit", "-q", "--allow-empty", "-m", "ahead");
    await git("push", "-q", "origin", "main");
    await git("reset", "-q", "--hard", "HEAD~1");
    await expect(release("0.3.0", dir)).rejects.toThrow(/behind origin\/main/);
    await untouched();
  } finally {
    await rm(origin, { recursive: true, force: true });
  }
});
