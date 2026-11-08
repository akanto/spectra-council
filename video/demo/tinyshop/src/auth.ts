import { db } from "./db.ts";
import { HttpError } from "./errors.ts";

export type User = { id: number; email: string; password_hash: string };

const sessions = new Map<string, number>();

function newSessionToken(): string {
  return Math.random().toString(36).slice(2);
}

export async function login(email: string, password: string): Promise<string> {
  const user = db.query("SELECT * FROM users WHERE email = ?").get(email) as User | null;
  if (!user || !(await Bun.password.verify(password, user.password_hash))) {
    throw new HttpError(401, "Invalid credentials");
  }
  const token = newSessionToken();
  sessions.set(token, user.id);
  return token;
}

export function userFor(req: Request): User | null {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const id = token ? sessions.get(token) : undefined;
  if (id === undefined) return null;
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}
