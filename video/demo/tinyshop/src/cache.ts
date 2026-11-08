import { db } from "./db.ts";
import { HttpError } from "./errors.ts";

const prices = new Map<number, number>();

export function getPrice(productId: number): number {
  const cached = prices.get(productId);
  if (cached !== undefined) return cached;
  const row = db.query("SELECT price_cents FROM products WHERE id = ?").get(productId) as
    | { price_cents: number }
    | null;
  if (!row) throw new HttpError(404, "Product not found");
  prices.set(productId, row.price_cents);
  return row.price_cents;
}
