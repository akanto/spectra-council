import { Fragment, type ReactNode } from "react";
import type { Review } from "../core/model.ts";
import { parseMarkdown, type Inline } from "./markdown.ts";
import { cx, mergedInto } from "./ui.tsx";

interface Context {
  review: Review;
  merged: Map<string, string>;
  select?: (id: string) => void;
  openPath?: (path: string) => void;
}

function renderInlines(inlines: Inline[], ctx: Context): ReactNode[] {
  return inlines.map((inline, index) => {
    switch (inline.kind) {
      case "text":
        return <Fragment key={index}>{inline.text}</Fragment>;
      case "code":
        return <code key={index} className="md-code">{inline.text}</code>;
      case "strong":
        return <strong key={index}>{renderInlines(inline.children, ctx)}</strong>;
      case "finding": {
        const id = inline.id;
        const target = ctx.review.findings.some((finding) => finding.id === id) ? id : ctx.merged.get(id);
        const select = ctx.select;
        if (!target || !select) return <Fragment key={index}>{id}</Fragment>;
        return (
          <button key={index} className="link finding-ref" title={target === id ? undefined : `${id} was merged into ${target}`} onClick={() => select(target)}>
            {id}
          </button>
        );
      }
      case "path": {
        const { path, text } = inline;
        const openPath = ctx.openPath;
        if (!openPath) return <code key={index} className="md-code">{text}</code>;
        return (
          <button key={index} className="link mono md-path" title={`Open ${path}`} onClick={() => openPath(path)}>
            {text}
          </button>
        );
      }
    }
  });
}

export function Markdown({ text, review, select, openPath, inline, className }: { text: string; review: Review; select?: (id: string) => void; openPath?: (path: string) => void; inline?: boolean; className?: string }) {
  const ctx: Context = { review, merged: mergedInto(review), select, openPath };
  const blocks = parseMarkdown(text);
  if (inline) {
    const parts: ReactNode[] = [];
    blocks.forEach((block, index) => {
      if (index > 0) parts.push(" ");
      if (block.kind === "paragraph") parts.push(<Fragment key={index}>{renderInlines(block.inlines, ctx)}</Fragment>);
      else if (block.kind === "code") parts.push(<code key={index} className="md-code">{block.text}</code>);
      else
        parts.push(
          <Fragment key={index}>
            {block.items.map((item, at) => (
              <Fragment key={at}>
                {at > 0 && "; "}
                {renderInlines(item, ctx)}
              </Fragment>
            ))}
          </Fragment>,
        );
    });
    return <span className={cx("md", className)}>{parts}</span>;
  }
  return (
    <div className={cx("md", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "paragraph") return <p key={index} className={index === 0 && blocks.length > 1 ? "md-lead" : undefined}>{renderInlines(block.inlines, ctx)}</p>;
        if (block.kind === "code")
          return (
            <pre key={index} className="md-pre">
              <code>{block.text}</code>
            </pre>
          );
        const items = block.items.map((item, at) => <li key={at}>{renderInlines(item, ctx)}</li>);
        return block.ordered ? (
          <ol key={index} {...(block.start !== undefined ? { start: block.start } : {})}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      })}
    </div>
  );
}
