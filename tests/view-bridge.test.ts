import { describe, expect, test } from "bun:test";
import { REVIEW_FORMAT, type Review } from "../core/model.ts";
import type { PluginItem, PluginItemContext, PluginViewBridge } from "../hosts/mirador/api.ts";
import { councilBridge, describeError } from "../hosts/mirador/view-bridge.ts";

/** A `window.mirador` whose item listener the test calls, as Mirador's bridge does from its message handler. */
function fakeMirador(overrides: Partial<PluginViewBridge<Review>> = {}) {
  let listener: ((item: PluginItem<Review>, context: PluginItemContext) => void) | undefined;
  const mirador: PluginViewBridge<Review> = {
    onItem: (each) => {
      listener = each;
      return () => (listener = undefined);
    },
    send: async () => "ok",
    prompt: async () => {},
    setFullscreen: () => {},
    ...overrides,
  };
  const post = (data: unknown) => listener!({ data } as PluginItem<Review>, {} as PluginItemContext);
  return { mirador, post };
}

function reporter() {
  const reports: string[] = [];
  return { reports, report: (what: string, error: unknown) => void reports.push(`${what}: ${describeError(error)}`) };
}

describe("the view's bridge in Mirador", () => {
  test("hands the listener the review", () => {
    const { mirador, post } = fakeMirador();
    const seen: Review[] = [];
    councilBridge(mirador).onReview((review) => seen.push(review));
    const review = { format: REVIEW_FORMAT, id: "r" } as Review;
    post(review);
    expect(seen).toEqual([review]);
  });

  test("reports what the listener throws instead of letting it leave through Mirador's bridge", () => {
    const { mirador, post } = fakeMirador();
    const { reports, report } = reporter();
    councilBridge(mirador, report).onReview(() => {
      throw new TypeError("review.findings is undefined");
    });
    expect(() => post({ format: REVIEW_FORMAT } as Review)).not.toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toStartWith("couldn't show the review: TypeError: review.findings is undefined");
  });

  test("reports a review it can't upgrade", () => {
    const { mirador, post } = fakeMirador();
    const { reports, report } = reporter();
    councilBridge(mirador, report).onReview(() => {});
    expect(() => post({ format: 1 } as unknown as Review)).not.toThrow();
    expect(reports[0]).toStartWith("couldn't show the review: TypeError");
  });

  test("passes a send's rejection through without a report: the view shows it", async () => {
    const { mirador } = fakeMirador({ send: () => Promise.reject(new Error("refused")) });
    const { reports, report } = reporter();
    await expect(councilBridge(mirador, report).send({ kind: "stop" })).rejects.toThrow("refused");
    expect(reports).toEqual([]);
  });

  test("offers openFile only where Mirador opens files", () => {
    expect(councilBridge(fakeMirador().mirador).openFile).toBeUndefined();
    const opened: string[] = [];
    councilBridge(fakeMirador({ openFile: (path) => void opened.push(path) }).mirador).openFile!("/a/b.ts");
    expect(opened).toEqual(["/a/b.ts"]);
  });

  test("lets what openFile throws reach the view, which shows it", () => {
    const { mirador } = fakeMirador({
      openFile: () => {
        throw new Error("no such file");
      },
    });
    expect(() => councilBridge(mirador).openFile!("/a")).toThrow("no such file");
  });

  test("describes an error by name, message and where it was thrown", () => {
    const error = new RangeError("too far");
    error.stack = "RangeError: too far\n    at render (blob:x:1:2)\n    at other";
    expect(describeError(error)).toBe("RangeError: too far (render (blob:x:1:2))");
    expect(describeError("plain")).toBe("plain");
  });

  test("skips V8's message lines, even one that looks like a frame", () => {
    const error = new Error("cannot resolve @types/foo\nat the end");
    error.stack = "Error: cannot resolve @types/foo\nat the end\n    at load (blob:x:3:4)";
    expect(describeError(error)).toBe("Error: cannot resolve @types/foo\nat the end (load (blob:x:3:4))");
  });

  test("takes WebKit's first frame of the page's code, not a native one", () => {
    const error = new SyntaxError("JSON Parse error: Unexpected EOF");
    error.stack = "parse@[native code]\nreadItem@blob:http://127.0.0.1/abc:68:35139\nglobal code@blob:x:1:1";
    expect(describeError(error)).toBe("SyntaxError: JSON Parse error: Unexpected EOF (readItem@blob:http://127.0.0.1/abc:68:35139)");
  });

  test("describes a value that can't be made text without throwing", () => {
    expect(describeError(Object.create(null))).toBe("[object Object]");
    expect(describeError({ toString: () => { throw new Error("no"); } })).toBe("[object Object]");
  });
});
