/**
 * The files of a review target, relative to it: a git repository's tracked and unignored files, else a walk of the folder
 * that skips what is usually generated; a single file is itself. Uses Bun, which every host of the engine runs on.
 */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 5000;

const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|out|target|coverage|\.venv|venv|__pycache__|\.next|\.cache)\//;
const NOT_REVIEWED = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|mp4|mov)$/i;

/** What a target is: a folder, a file, or nothing there. */
export async function targetKind(target: string): Promise<"folder" | "file" | null> {
  try {
    const info = await stat(target);
    return info.isDirectory() ? "folder" : info.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

async function gitFiles(folder: string): Promise<string[] | null> {
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: folder, stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
    return code === 0 ? text.split("\0").filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function walkedFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*").scan({ cwd: folder, dot: false, onlyFiles: true })) {
    if (SKIPPED.test(`${file}/`) || SKIPPED.test(file)) continue;
    files.push(file);
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

export async function listTargetFiles(target: string): Promise<string[]> {
  const kind = await targetKind(target);
  if (kind === "file") return [basename(target)];
  if (kind !== "folder") return [];
  const files = (await gitFiles(target)) ?? (await walkedFiles(target));
  return files.filter((file) => !SKIPPED.test(file) && !NOT_REVIEWED.test(file)).slice(0, MAX_FILES).sort();
}

/** The real path of `path`, or of its nearest existing ancestor with the missing tail put back. */
async function realOrNearest(path: string): Promise<string> {
  let existing = path;
  let tail = "";
  for (;;) {
    try {
      return join(await realpath(existing), tail);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail = tail ? join(basename(existing), tail) : basename(existing);
      existing = parent;
    }
  }
}

/**
 * Resolve a source link against the target's actual filesystem kind, never its extension. The result must stay inside
 * the target (its folder, or the folder of a single-file target), symlinks included: reviewer output is untrusted, so
 * `../x`, `/etc/passwd` and links pointing out are rejected. Absolute paths are accepted only when they are inside.
 */
export async function resolveTargetPath(target: string, path: string): Promise<string> {
  const kind = await targetKind(target);
  if (!kind) throw new Error(`Cannot resolve source path: review target ${target} is unavailable.`);
  const base = kind === "file" ? dirname(target) : target;
  const realBase = await realpath(base);
  const candidate = resolve(base, path);
  const inside = relative(realBase, await realOrNearest(candidate));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Cannot open source path ${path}: it is outside the review target.`);
  }
  return candidate;
}
