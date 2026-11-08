import type { User } from "./auth.ts";
import { db } from "./db.ts";
import { HttpError } from "./errors.ts";

export function getOrder(id: number, user: User | null) {
  if (!user) throw new HttpError(401, "Sign in first");
  const order = db.query("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}
