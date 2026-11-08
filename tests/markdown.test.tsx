import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newReview, reduce } from "../core/review.ts";
import type { Review } from "../core/model.ts";
import { Markdown } from "../view/Markdown.tsx";
import { parseInline, parseMarkdown } from "../view/markdown.ts";

function review(): Review {
  const seats = ["mock-claude", "mock-codex"].map((agent) => ({ agent, enabled: true }));
  let r = reduce(newReview("rev1", { target: "/repo", profile: "code", depth: "standard", instructions: "", seats }, "mock", 0), { type: "started", at: 1 });
  r = reduce(r, { type: "reviewer-started", reviewerId: "r1", at: 2 });
  return reduce(r, { type: "finding-reported", reviewerId: "r1", at: 3, finding: { title: "T", summary: "S", severity: "medium", confidence: "high", category: "correctness", evidence: [{ path: "src/a.ts", line: 3 }] } });
}

describe("parseMarkdown", () => {
  test("empty", () => expect(parseMarkdown("")).toEqual([]));
  test("paragraphs and soft breaks", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "one two" }] },
      { kind: "paragraph", inlines: [{ kind: "text", text: "three" }] },
    ]);
  });
  test("list directly after a paragraph line, both markers", () => {
    const blocks = parseMarkdown("Causes:\n- a\n* b");
    expect(blocks.length).toBe(2);
    expect(blocks[1]).toMatchObject({ kind: "list", items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] });
  });
  test("list after a blank line with continuation", () => {
    const blocks = parseMarkdown("Intro\n\n- first\n  more\n- second");
    expect(blocks[1]).toMatchObject({ kind: "list", items: [[{ kind: "text", text: "first more" }], [{ kind: "text", text: "second" }]] });
  });
});

describe("parseMarkdown, after review", () => {
  test("numbered lists keep their start and survive blank lines between items", () => {
    expect(parseMarkdown("Steps:\n1. a\n\n2. b\n\n3. c")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Steps:" }] },
      { kind: "list", ordered: true, items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }], [{ kind: "text", text: "c" }]] },
    ]);
    expect(parseMarkdown("3. a\n4. b")).toEqual([{ kind: "list", ordered: true, start: 3, items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] }]);
  });
  test("a wrapped line starting with a number stays in its paragraph", () => {
    expect(parseMarkdown("It was fixed in\n2024. Then it broke")).toEqual([{ kind: "paragraph", inlines: [{ kind: "text", text: "It was fixed in 2024. Then it broke" }] }]);
  });
  test("a blank line then a paragraph ends the list", () => {
    expect(parseMarkdown("- a\n\nafter").map((block) => block.kind)).toEqual(["list", "paragraph"]);
  });
  test("fenced code is kept verbatim, lists inside it too", () => {
    expect(parseMarkdown("Example:\n```ts\nconst x = a<b>();\n- not a list\n```\nafter")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "Example:" }] },
      { kind: "code", text: "const x = a<b>();\n- not a list" },
      { kind: "paragraph", inlines: [{ kind: "text", text: "after" }] },
    ]);
    expect(parseMarkdown("```\nunclosed")).toEqual([{ kind: "code", text: "unclosed" }]);
  });
});

describe("parseInline", () => {
  test("bold needs flanking: bare ** pairs stay text", () => {
    expect(parseInline("pass **kwargs and **opts through")).toEqual([{ kind: "text", text: "pass **kwargs and **opts through" }]);
    expect(parseInline("2 ** 3 ** 4")).toEqual([{ kind: "text", text: "2 ** 3 ** 4" }]);
    expect(parseInline("**see `a**b`**")).toEqual([{ kind: "strong", children: [{ kind: "text", text: "see " }, { kind: "code", text: "a**b" }] }]);
  });
  test("backtick runs pair by length; an empty pair is text", () => {
    expect(parseInline("use `` then `x` ok")).toEqual([{ kind: "text", text: "use `` then " }, { kind: "code", text: "x" }, { kind: "text", text: " ok" }]);
    expect(parseInline("`` a`b ``")).toEqual([{ kind: "code", text: "a`b" }]);
  });
  test("hosts are not files; scoped packages and bare files are", () => {
    expect(parseInline("connects to api.example.com:443 and redis.internal:6379")).toEqual([{ kind: "text", text: "connects to api.example.com:443 and redis.internal:6379" }]);
    expect(parseInline("node_modules/@types/node/index.d.ts:12")).toEqual([{ kind: "path", path: "node_modules/@types/node/index.d.ts", line: 12, text: "node_modules/@types/node/index.d.ts:12" }]);
    expect(parseInline("Makefile:12").at(0)).toMatchObject({ kind: "path", path: "Makefile" });
    expect(parseInline(".env:3").at(0)).toMatchObject({ kind: "path", path: ".env" });
  });

  test("code, bold, literal unmatched", () => {
    expect(parseInline("a `x` b")).toEqual([{ kind: "text", text: "a " }, { kind: "code", text: "x" }, { kind: "text", text: " b" }]);
    expect(parseInline("**b**")).toEqual([{ kind: "strong", children: [{ kind: "text", text: "b" }] }]);
    expect(parseInline("a ` b")).toEqual([{ kind: "text", text: "a ` b" }]);
    expect(parseInline("a ** b")).toEqual([{ kind: "text", text: "a ** b" }]);
  });
  test("code keeps ** and F1", () => expect(parseInline("`**F1**`")).toEqual([{ kind: "code", text: "**F1**" }]));
  test("references that leave the project are plain text, not paths", () => {
    for (const text of ["../../.env:1", "src/../../x.ts:2", "/etc/passwd:1"]) {
      expect(parseInline(text).some((part) => part.kind === "path")).toBe(false);
      expect(parseInline(`\`${text}\``).some((part) => part.kind === "path")).toBe(false);
    }
  });
  test("code with file:line is a path", () => expect(parseInline("`src/a.ts:3`")).toEqual([{ kind: "path", path: "src/a.ts", line: 3, text: "src/a.ts:3" }]));
  test("file:line with range and trailing period", () => {
    expect(parseInline("see core/api.ts:42-50.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", path: "core/api.ts", line: 42, endLine: 50, text: "core/api.ts:42-50" },
      { kind: "text", text: "." },
    ]);
  });
  test("URL with port and bare file are not paths", () => {
    expect(parseInline("http://host.com:80/x")).toEqual([{ kind: "text", text: "http://host.com:80/x" }]);
    expect(parseInline("in Setup.tsx")).toEqual([{ kind: "text", text: "in Setup.tsx" }]);
  });
  test("finding ids", () => {
    expect(parseInline("see F6, not XF6")).toEqual([{ kind: "text", text: "see " }, { kind: "finding", id: "F6" }, { kind: "text", text: ", not XF6" }]);
  });
  test("adversarial input is fast", () => {
    const start = performance.now();
    for (const s of ["**`*`**".repeat(1500), "`".repeat(10000), "**".repeat(5000), "a.".repeat(5000), "a/".repeat(5000) + ":1", "F".repeat(10000)]) parseMarkdown(s);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("Markdown", () => {
  const r = review();
  test("raw HTML is escaped", () => {
    const html = renderToStaticMarkup(<Markdown text={"<script>alert(1)</script> <img src=x onerror=alert(1)>"} review={r} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
  test("code and bold", () => {
    const html = renderToStaticMarkup(<Markdown text="`x` and **y**" review={r} />);
    expect(html).toContain("<code");
    expect(html).toContain("<strong>y</strong>");
  });
  test("finding ids", () => {
    const html = renderToStaticMarkup(<Markdown text="F1 and F99" review={r} select={() => {}} />);
    expect(html).toContain("<button");
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain("F99");
  });
  test("paths", () => {
    expect(renderToStaticMarkup(<Markdown text="src/a.ts:3" review={r} openPath={() => {}} />)).toContain("<button");
    const without = renderToStaticMarkup(<Markdown text="src/a.ts:3" review={r} />);
    expect(without).toContain("<code");
    expect(without).not.toContain("<button");
  });
  test("code blocks and numbered lists from a start", () => {
    const html = renderToStaticMarkup(<Markdown text={"```\n<b>x</b>\n```\n\n3. a\n4. b"} review={r} />);
    expect(html).toContain('<pre class="md-pre"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
    expect(html).toContain('<ol start="3">');
  });
  test("inline mode has no block elements", () => {
    const html = renderToStaticMarkup(<Markdown text={"one\n\ntwo\n- a\n- b"} review={r} inline />);
    expect(html).not.toContain("<p");
    expect(html).not.toContain("<ul");
    expect(html).toContain("a; b");
  });
});
