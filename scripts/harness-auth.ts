/**
 * The development harness's access checks, as small pure functions so they can be tested without a browser.
 *
 * The harness listens on loopback only, but any web page the developer visits can still open a WebSocket to it, and
 * DNS rebinding can make a hostile name resolve to 127.0.0.1. So: the Host header must be the harness's own authority,
 * a socket upgrade must come from a page the harness itself served (exact Origin), and the socket must then present a
 * random token that only the Host-validated HTML page carries.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh 256-bit token, hex encoded. It lives as long as the harness process. */
export const newToken = () => randomBytes(32).toString("hex");

/** The authorities the harness answers to: its bound loopback address and `localhost`, on its actual port. */
export const allowedHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

/** Whether a Host header is one of the harness's own authorities (compared exactly, case-insensitively). */
export function hostAllowed(host: string | null, port: number) {
  return host !== null && allowedHosts(port).includes(host.toLowerCase());
}

/** Whether an Origin header is exactly the harness's own origin. Missing, "null" and malformed origins are refused. */
export function originAllowed(origin: string | null, port: number) {
  return origin !== null && allowedHosts(port).some((host) => origin === `http://${host}`);
}

/** Whether a socket upgrade may proceed: right Host and right Origin. Forwarded headers are never consulted. */
export function upgradeAllowed(headers: Pick<Headers, "get">, port: number) {
  return hostAllowed(headers.get("host"), port) && originAllowed(headers.get("origin"), port);
}

/** Constant-time token comparison; anything that isn't a string of the right length fails. */
export function tokenMatches(given: unknown, token: string) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type SocketMessage = { kind: "auth"; token: unknown } | { kind: "action"; requestId: number; action: unknown };

/** Parses a socket message; null when it isn't one of the two the bridge sends. */
export function parseSocketMessage(raw: string | Buffer | ArrayBuffer | Uint8Array): SocketMessage | null {
  if (typeof raw !== "string" && !(raw instanceof Uint8Array)) return null;
  try {
    const message = JSON.parse(String(raw)) as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return null;
    if (message.kind === "auth") return { kind: "auth", token: message.token };
    if (typeof message.requestId === "number" && "action" in message) return { kind: "action", requestId: message.requestId, action: message.action };
  } catch {
    // fall through
  }
  return null;
}

/** A socket's states: it must authenticate first, is "opening" while the review is created, then "ready". */
export type SocketState = "unauthenticated" | "opening" | "ready";

/** How long a socket may stay unauthenticated, in milliseconds. */
export const AUTH_TIMEOUT_MS = 5000;
