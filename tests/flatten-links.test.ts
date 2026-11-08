import { expect, test } from "bun:test";
import { flattenLinks } from "../core/agent-runner.ts";

test("flattens a plain link to its text", () => {
  expect(flattenLinks("See [the docs](https://example.com/a) now")).toBe("See the docs now");
});

test("flattens a file:// link with a line anchor", () => {
  expect(flattenLinks("[F2](file:///Users/x/core/deliberation.ts#L93-L115) overlaps")).toBe("F2 overlaps");
});

test("flattens several links", () => {
  expect(flattenLinks("[F1](file:///a#L1), [F2](file:///b#L2) and [F3](http://c)")).toBe("F1, F2 and F3");
});

test("leaves text without links alone", () => {
  expect(flattenLinks("No links [here] or (there)")).toBe("No links [here] or (there)");
});

test("empty link text falls back to the file name and line", () => {
  expect(flattenLinks("[](file:///Users/x/core/deliberation.ts#L93-L115)")).toBe("deliberation.ts:93");
  expect(flattenLinks("[](https://example.com/a/b)")).toBe("b");
});

test("keeps nested brackets and drops link titles; images stay", () => {
  expect(flattenLinks("[a [b]](http://x)")).toBe("a [b]");
  expect(flattenLinks('[t](http://x "title")')).toBe("t");
  expect(flattenLinks("![img](http://x)")).toBe("![img](http://x)");
});
