/**
 * `window.mirador` made into the view's CouncilBridge, saying what went wrong in words Mirador can show.
 *
 * WebKit tells Mirador's opaque-origin canvas frame only "Script error." of an exception that leaves through one of
 * Mirador's own scripts, and Mirador then says "A script on the page threw an error; this browser hides its message."
 * The bridge calls our item listener from its message handler, so what the listener throws leaves that way. Mirador
 * records what `console.error` says, message and all: the listener reports there instead. (`send` and `openFile` need
 * nothing of the kind: the bridge's `send` rejects rather than throws, and the view calls `openFile` in a promise chain
 * that shows what it throws.)
 */
import type { Review } from "../../core/model.ts";
import { upgradeReview } from "../../core/review.ts";
import type { CouncilBridge } from "../../view/bridge.ts";
import type { PluginViewBridge } from "./api.ts";

/** A stack frame of the page's code: V8's "at fn (url:1:2)", or WebKit's "fn@url:1:2"; not a native one. */
const isFrame = (line: string) => (/^at /.test(line) || /^[^\s@]*@\S+:\d+:\d+$/.test(line)) && !line.includes("[native code]");

/** A value as text, even one that has no `toString` or whose `toString` throws. */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** An error as one line: its name and message, and the first frame of the page's code it was thrown in, when the stack says. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return textOf(error);
  // V8 starts the stack with the error's own "Name: message" lines; WebKit leaves them out.
  const lines = (typeof error.stack === "string" ? error.stack.split("\n") : []).map((line) => line.trim());
  const frames = lines[0]?.startsWith(`${error.name}:`) ? lines.slice(textOf(error.message).split("\n").length) : lines;
  const at = frames.find(isFrame);
  return `${error.name}: ${textOf(error.message)}${at ? ` (${at.replace(/^at /, "")})` : ""}`;
}

export type Report = (what: string, error: unknown) => void;

/** Reports to the console, where Mirador picks it up. */
export const reportToConsole: Report = (what, error) => console.error(`Spectra Council: ${what}: ${describeError(error)}`);

export function councilBridge(mirador: PluginViewBridge<Review>, report: Report = reportToConsole): CouncilBridge {
  return {
    onReview: (listener) =>
      mirador.onItem((item) => {
        try {
          listener(upgradeReview(item.data));
        } catch (error) {
          report("couldn't show the review", error);
        }
      }),
    send: (action) => mirador.send(action),
    ...(mirador.openFile ? { openFile: (path: string) => mirador.openFile!(path) } : {}),
  };
}
