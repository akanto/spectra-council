import type { User } from "./auth.ts";
import { getPrice } from "./cache.ts";
import { db } from "./db.ts";
import { HttpError } from "./errors.ts";
import { charge } from "./payments.ts";

export async function checkout(user: User, productId: number, qty: number) {
  const product = db.query("SELECT stock, price_cents FROM products WHERE id = ?").get(productId) as
    | { stock: number; price_cents: number }
    | null;
  if (!product) throw new HttpError(404, "Product not found");
  if (product.stock < qty) throw new HttpError(409, "Not enough stock");

  const total = getPrice(productId) * qty;
  await charge(user, total);

  db.query("UPDATE products SET stock = ? WHERE id = ?").run(product.stock - qty, productId);
  const createdAt = new Date().toISOString();
  const { lastInsertRowid } = db
    .query("INSERT INTO orders (user_id, product_id, qty, total_cents, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(user.id, productId, qty, total, createdAt);
  return { id: Number(lastInsertRowid), productId, qty, total_cents: total };
}
