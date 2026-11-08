import { beforeEach, expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db.ts");
const { checkout } = await import("../src/checkout.ts");

const user = { id: 1, email: "ann@example.com", password_hash: "x" };

beforeEach(() => {
  db.run("DELETE FROM orders");
  db.run("DELETE FROM products");
  db.run("INSERT INTO products (id, name, price_cents, stock) VALUES (1, 'Mug', 1200, 5)");
});

test("checkout lowers stock and records the order", async () => {
  const order = await checkout(user, 1, 2);
  expect(order.total_cents).toBe(2400);
  const product = db.query("SELECT stock FROM products WHERE id = 1").get() as { stock: number };
  expect(product.stock).toBe(3);
  const row = db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
  expect(row.n).toBe(1);
});

test("checkout of more than the stock fails with 409", async () => {
  await expect(checkout(user, 1, 6)).rejects.toMatchObject({ status: 409 });
});
