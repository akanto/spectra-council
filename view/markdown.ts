/** A small, safe Markdown subset for text written by AI reviewers. Pure: no React, no HTML, never throws. */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "finding"; id: string }
  | { kind: "path"; path: string; line: number; endLine?: number; text: string };
export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  /** A bullet list, or a numbered one from `start`. */
  | { kind: "list"; items: Inline[][]; ordered?: boolean; start?: number }
  /** A fenced code block, verbatim. */
  | { kind: "code"; text: string };

const CODE_MAX = 400;

/** Hosts look like files ("api.example.com:443"); these endings make a name a host, not a file. */
const HOST_ENDINGS = new Set(["com", "org", "net", "io", "dev", "co", "ai", "app", "edu", "gov", "internal", "local", "localhost", "cloud", "svc", "cluster"]);

/** Files without an extension that reviewers cite. */
const BARE_FILES = new Set(["Makefile", "Dockerfile", "Containerfile", "Gemfile", "Rakefile", "Procfile", "Jenkinsfile", "Justfile", "Vagrantfile", "LICENSE", "README"]);

/** A relative path to a file: `name.ext` (ext starts with a letter), a dotfile like `.env`, or a known bare file name. */
function isPathLike(path: string): boolean {
  if (path.length === 0 || path.length > CODE_MAX || path.startsWith("/") || path.split("/").includes("..") || path.endsWith("/") || path.includes("//")) return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (BARE_FILES.has(last)) return true;
  const dot = last.lastIndexOf(".");
  if (dot === 0) return /^\.[A-Za-z][\w.-]*$/.test(last);
  if (dot < 0) return false;
  const ext = last.slice(dot + 1);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(ext)) return false;
  // "redis.internal", "api.example.com": a host, unless it sits under a folder.
  return path.includes("/") || !HOST_ENDINGS.has(ext.toLowerCase());
}

const lineRef = /^:(\d+)(?:-(\d+))?/;

function pathInline(path: string, tail: RegExpExecArray, text: string): Inline {
  const line = Number(tail[1]);
  const end = tail[2] === undefined ? undefined : Number(tail[2]);
  return end === undefined ? { kind: "path", path, line, text } : { kind: "path", path, line, endLine: end, text };
}

/** Code whose whole content is `path:line[-end]`. */
function wholePath(content: string): Inline | undefined {
  if (content.length > CODE_MAX) return undefined;
  const colon = content.lastIndexOf(":");
  if (colon < 1) return undefined;
  const path = content.slice(0, colon);
  const tail = lineRef.exec(content.slice(colon));
  if (!tail || tail[0].length !== content.length - colon || !isPathLike(path) || /[^\w./@-]/.test(path)) return undefined;
  return pathInline(path, tail, content);
}

/** Plain text: file:line references and finding ids. */
function plain(run: string, out: Inline[]) {
  const push = (text: string) => {
    if (text) out.push({ kind: "text", text });
  };
  const ids = (text: string) => {
    text.split(/(\bF\d+\b)/).forEach((part, index) => {
      if (index % 2 === 1) out.push({ kind: "finding", id: part });
      else push(part);
    });
  };
  const token = /[\w./@-]+/g;
  let last = 0;
  for (let m = token.exec(run); m; m = token.exec(run)) {
    const start = m.index;
    const end = start + m[0].length;
    if (run[start - 1] === ":" || run[start - 1] === "\\" || run[end] !== ":" || m[0].length > CODE_MAX || !isPathLike(m[0])) continue;
    const tail = lineRef.exec(run.slice(end, end + 24));
    if (!tail) continue;
    ids(run.slice(last, start));
    out.push(pathInline(m[0], tail, run.slice(start, end + tail[0].length)));
    last = end + tail[0].length;
    token.lastIndex = last;
  }
  ids(run.slice(last));
}

/** How many backticks start at `at`. */
function runAt(text: string, at: number): number {
  let n = 0;
  while (text[at + n] === "`") n++;
  return n;
}

/** Where a run of exactly `n` backticks starts after `from`, or -1. */
function closingRun(text: string, from: number, n: number): number {
  for (let at = text.indexOf("`", from); at !== -1; ) {
    const length = runAt(text, at);
    if (length === n) return at;
    at = text.indexOf("`", at + length);
  }
  return -1;
}

/**
 * Where the `**` closing a bold that opens before `from` is: preceded by a non-space, outside a code span; -1 if none.
 * A run of backticks with no partner is plain text, as in parseInline.
 */
function closingStrong(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === "`") {
      const n = runAt(text, at);
      const close = closingRun(text, at + n, n);
      at = close === -1 ? at + n : close + n;
      continue;
    }
    if (char === "*" && text[at + 1] === "*" && at > from && !/\s/.test(text[at - 1]!)) return at;
    at++;
  }
  return -1;
}

export function parseInline(text: string, allowStrong = true): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  // Past these points no closer exists, so later openers are plain text (keeps the parse linear).
  const noRun = new Set<number>();
  let noStrong = false;
  const flush = () => {
    if (buffer) plain(buffer, out);
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "`") {
      const n = runAt(text, i);
      const close = noRun.has(n) ? -1 : closingRun(text, i + n, n);
      if (close === -1) {
        noRun.add(n);
        buffer += "`".repeat(n);
        i += n;
        continue;
      }
      flush();
      let content = text.slice(i + n, close);
      // "`` `a` ``": one space on each side is padding.
      if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
      out.push(wholePath(content) ?? { kind: "code", text: content });
      i = close + n;
      continue;
    }
    // "**bold**": the opener is followed by a non-space, the closer preceded by one ("2 ** 3", "**kwargs and **opts" stay).
    if (char === "*" && text[i + 1] === "*" && allowStrong && !noStrong && text[i + 2] !== undefined && !/[\s*]/.test(text[i + 2]!)) {
      const close = closingStrong(text, i + 2);
      if (close === -1) noStrong = true;
      else {
        flush();
        out.push({ kind: "strong", children: parseInline(text.slice(i + 2, close), false) });
        i = close + 2;
        continue;
      }
    }
    buffer += char;
    i++;
  }
  flush();
  return out;
}

const BULLET = /^\s*(?:([-*])|(\d{1,9})[.)])\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | undefined;
  // A blank line inside a list ends it only if what follows isn't another item of it.
  let gap = false;
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (list) blocks.push({ kind: "list", items: list.items.map((item) => parseInline(item)), ordered: list.ordered, ...(list.ordered && list.start !== 1 ? { start: list.start } : {}) });
    list = undefined;
    gap = false;
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trimEnd();
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      endList();
      const marker = fence[1]!;
      const body: string[] = [];
      for (index++; index < lines.length; index++) {
        const inner = lines[index]!;
        if (inner.trim().startsWith(marker[0]!.repeat(marker.length)) && inner.trim().replace(new RegExp(`^\\${marker[0]}+`), "") === "") break;
        body.push(inner);
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      endParagraph();
      if (list) gap = true;
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? bullet[2] !== undefined : false;
    const number = bullet?.[2] === undefined ? 1 : Number(bullet[2]);
    // A numbered line interrupts a paragraph only when it starts a list at 1 ("fixed in\n2024. Then" stays a paragraph).
    const startsItem = bullet !== null && !(ordered && paragraph.length > 0 && !list && number !== 1);
    if (startsItem) {
      endParagraph();
      if (list && list.ordered !== ordered) endList();
      list ??= { ordered, start: number, items: [] };
      gap = false;
      list.items.push((bullet[3] ?? "").trim());
    } else if (list && !gap && /^\s/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      endList();
      paragraph.push(line.trim());
    }
  }
  endParagraph();
  endList();
  return blocks;
}
