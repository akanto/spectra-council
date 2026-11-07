import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsonProblem, lastJson } from "../core/replies.ts";
import { reviewReplySchema } from "../core/schemas.ts";

const shape = z.object({ findings: z.array(z.unknown()) });

describe("lastJson", () => {
  test("reads a json block after a block with another language tag", () => {
    expect(lastJson("Prose\n```ts\nx\n```\nMore\n```json\n{\"findings\":[]}\n```", shape)).toEqual({ findings: [] });
  });

  test("pairs fences whose info strings have attributes, tildes or longer runs", () => {
    const report = '```json\n{"findings":[]}\n```';
    for (const quote of ['```ts title="core/a.ts"\nconst a = 1;\n```', "```c#\nint a;\n```", "```js {1,3}\nx\n```", "~~~ts\nx\n~~~", "````md\n```\ninner\n```\n````"]) {
      expect(lastJson(`Prose\n${quote}\nMore\n${report}`, shape)).toEqual({ findings: [] });
    }
    expect(lastJson('~~~json\n{"findings":[1]}\n~~~', shape)).toEqual({ findings: [1] });
    expect(lastJson('1. Report:\n\n    ```json\n    {"findings":[3]}\n    ```', shape)).toEqual({ findings: [3] });
    expect(lastJson('```json title="report"\n{"findings":[2]}\n```', shape)).toEqual({ findings: [2] });
  });

  test("reads a block whose strings hold ```", () => {
    const text = 'Done.\n```json\n{"findings":[{"quote":"/```(?:json)?/g"}]}\n```';
    expect(lastJson(text, shape)).toEqual({ findings: [{ quote: "/```(?:json)?/g" }] });
  });

  test("takes the last block that fits, untagged ones too, and skips ones that don't parse or fit", () => {
    const text = '```json\n{"findings":[1]}\n```\n```\n{"findings":[2]}\n```\n```json\n{"other":true}\n```\n```json\n{not json\n```';
    expect(lastJson(text, shape)).toEqual({ findings: [2] });
  });

  test("reads a block left open at the end of the reply", () => {
    expect(lastJson('Here:\n```json\n{"findings":[]}', shape)).toEqual({ findings: [] });
  });

  test("ignores blocks in other languages and text without blocks", () => {
    expect(lastJson('```js\n{"findings":[]}\n```', shape)).toBeNull();
    expect(lastJson('{"findings":[]}', shape)).toBeNull();
    expect(lastJson(null, shape)).toBeNull();
  });

  test("reads the live replies that the old parser lost", async () => {
    const read = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
    expect(lastJson(await read("home-reply.md"), reviewReplySchema)?.findings).toHaveLength(1);
    expect(lastJson(await read("home-reply-2.md"), reviewReplySchema)?.findings).toHaveLength(3);
  });
});

describe("jsonProblem", () => {
  test("says why no block was accepted", () => {
    expect(jsonProblem(null, shape)).toBe("the reply had no text");
    expect(jsonProblem("  ", shape)).toBe("the reply had no text");
    expect(jsonProblem("Just prose.\n```ts\nx\n```", shape)).toBe("no fenced ```json block");
    expect(jsonProblem('```json\n{"findings": [\n```', shape)).toMatch(/^the last JSON block doesn't parse: .+/);
    const misfit = jsonProblem('```json\n{"findings": 3}\n```', shape);
    expect(misfit).toStartWith("the last JSON block doesn't fit the shape: findings:");
    expect(misfit).not.toContain("\n");
  });
});
