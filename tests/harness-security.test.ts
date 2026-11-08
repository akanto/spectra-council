import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { allowedHosts, hostAllowed, newToken, originAllowed, parseSocketMessage, tokenMatches, upgradeAllowed } from "../scripts/harness-auth.ts";
import { startHarness, type RunningHarness } from "../scripts/harness.ts";

describe("harness-auth checks", () => {
  test("hosts and origins are exact, on the bound port", () => {
    expect(allowedHosts(4830)).toEqual(["127.0.0.1:4830", "localhost:4830"]);
    expect(hostAllowed("127.0.0.1:4830", 4830)).toBe(true);
    expect(hostAllowed("LOCALHOST:4830", 4830)).toBe(true);
    for (const host of [null, "", "127.0.0.1", "127.0.0.1:4831", "attacker.invalid", "attacker.invalid:4830", "127.0.0.1:4830.attacker.invalid", "localhost.attacker.invalid:4830", "0.0.0.0:4830", "[::1]:4830"]) {
      expect(hostAllowed(host, 4830)).toBe(false);
    }
    expect(originAllowed("http://127.0.0.1:4830", 4830)).toBe(true);
    expect(originAllowed("http://localhost:4830", 4830)).toBe(true);
    for (const origin of [null, "", "null", "http://attacker.invalid", "https://127.0.0.1:4830", "http://127.0.0.1:4831", "http://127.0.0.1:4830/", "http://127.0.0.1:4830@attacker.invalid", "http://127.0.0.1", "127.0.0.1:4830"]) {
      expect(originAllowed(origin, 4830)).toBe(false);
    }
  });

  test("an upgrade needs both; forwarded headers are ignored", () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(upgradeAllowed(headers({ host: "127.0.0.1:1", origin: "http://127.0.0.1:1" }), 1)).toBe(true);
    expect(upgradeAllowed(headers({ host: "127.0.0.1:1" }), 1)).toBe(false);
    expect(upgradeAllowed(headers({ origin: "http://127.0.0.1:1" }), 1)).toBe(false);
    expect(upgradeAllowed(headers({ host: "evil.invalid", origin: "http://127.0.0.1:1", "x-forwarded-host": "127.0.0.1:1" }), 1)).toBe(false);
  });

  test("tokens are 256-bit, unique, and compared exactly", () => {
    const token = newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(token);
    expect(tokenMatches(token, token)).toBe(true);
    for (const given of [undefined, null, 1, "", token.slice(1), token + "0", token.toUpperCase(), ["x"]]) expect(tokenMatches(given, token)).toBe(false);
  });

  test("socket messages are parsed strictly", () => {
    expect(parseSocketMessage('{"kind":"auth","token":"t"}')).toEqual({ kind: "auth", token: "t" });
    expect(parseSocketMessage('{"requestId":1,"action":{"kind":"stop"}}')).toEqual({ kind: "action", requestId: 1, action: { kind: "stop" } });
    for (const raw of ["", "nope", "null", "1", "[]", '{"requestId":"1","action":{}}', '{"requestId":1}', new ArrayBuffer(2)]) expect(parseSocketMessage(raw)).toBeNull();
  });
});

describe("the running harness", () => {
  let harness: RunningHarness;
  let base: string;
  let origin: string;
  const target = join(import.meta.dir, "..", "docs");

  beforeAll(() => {
    harness = startHarness({ target, port: 0 });
    base = `http://127.0.0.1:${harness.port}`;
    origin = base;
  });
  afterAll(async () => {
    await harness.stop();
  });

  const tokenOf = async () => {
    const html = await (await fetch(base)).text();
    return /const token = "([0-9a-f]{64})"/.exec(html)![1]!;
  };

  /** A socket and what it received; `closed` resolves with the close code. */
  function connect(headers: Record<string, string> | undefined) {
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/socket`, { headers } as never);
    const messages: any[] = [];
    const opened = new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
    });
    const closed = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    const next = async (kind: string) => {
      for (let i = 0; i < 200; i++) {
        const found = messages.find((message) => message.kind === kind);
        if (found) return found;
        await Bun.sleep(25);
      }
      throw new Error(`no ${kind} message`);
    };
    return { socket, messages, opened, closed, next };
  }

  test("serves the page only for its own Host, with the token and no caching", async () => {
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toMatch(/const token = "[0-9a-f]{64}"/);
    const token = await tokenOf();
    for (const host of ["attacker.invalid", `attacker.invalid:${harness.port}`, `127.0.0.1:${harness.port + 1}`, "127.0.0.1", `127.0.0.1.attacker.invalid:${harness.port}`]) {
      const refused = await fetch(base, { headers: { host } });
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(token);
    }
    expect((await fetch(`${base}/view.js`, { headers: { host: "attacker.invalid" } })).status).toBe(403);
  });

  test("refuses upgrades from a wrong, missing or null Origin, or a wrong Host", async () => {
    const bad: Record<string, string>[] = [
      { origin: "http://attacker.invalid" },
      { origin: "null" },
      {},
      { origin: `http://127.0.0.1:${harness.port + 1}` },
      { origin, host: "attacker.invalid" },
      { origin, host: `127.0.0.1:${harness.port + 1}` },
      { origin: "http://attacker.invalid", host: "attacker.invalid" },
    ];
    for (const headers of bad) {
      const client = connect(headers);
      expect(await client.opened).toBe(false);
      expect(client.messages).toEqual([]);
    }
  });

  test("a valid origin without the token gets no review and cannot act", async () => {
    // Wrong token, then an action before any auth, then a malformed message, then a non-string token.
    for (const first of [{ kind: "auth", token: "0".repeat(64) }, { kind: "auth", token: 1 }, { requestId: 1, action: { kind: "configure", target: "/tmp" } }, "garbage"]) {
      const client = connect({ origin });
      expect(await client.opened).toBe(true);
      client.socket.send(typeof first === "string" ? first : JSON.stringify(first));
      expect(await client.closed).toBe(1008);
      expect(client.messages).toEqual([]);
    }
  });

  test("a socket that closes before authenticating leaves no review", async () => {
    const client = connect({ origin });
    expect(await client.opened).toBe(true);
    client.socket.close();
    await client.closed;
    expect(client.messages).toEqual([]);
  });

  test("an authenticated page gets its review, then configure and start work", async () => {
    const token = await tokenOf();
    const client = connect({ origin });
    expect(await client.opened).toBe(true);
    client.socket.send(JSON.stringify({ kind: "auth", token }));
    const item = (await client.next("item")).item;
    expect(item.data.target).toBe(target);
    await client.next("ready");
    // Ready arrives after the review exists.
    expect(client.messages.findIndex((message) => message.kind === "item")).toBeLessThan(client.messages.findIndex((message) => message.kind === "ready"));

    client.socket.send(JSON.stringify({ requestId: 1, action: { kind: "stop" } }));
    const reply = await client.next("reply");
    expect(reply.requestId).toBe(1);
    expect(reply.problem).toBeUndefined();
    client.socket.close();
    await client.closed;
  });

  test("a second auth on a ready socket, or localhost with the token, behaves", async () => {
    const token = await tokenOf();
    const client = connect({ origin: `http://localhost:${harness.port}`, host: `localhost:${harness.port}` });
    expect(await client.opened).toBe(true);
    client.socket.send(JSON.stringify({ kind: "auth", token }));
    await client.next("ready");
    client.socket.send(JSON.stringify({ kind: "auth", token }));
    expect(await client.closed).toBe(1008);
  });
});
