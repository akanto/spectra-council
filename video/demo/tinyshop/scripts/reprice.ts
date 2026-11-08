import { readFileSync } from "node:fs";
import { db } from "../src/db.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/reprice.ts prices.csv");
  process.exit(1);
}

const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => line.split(",").map(Number) as [number, number]);

const update = db.query("UPDATE products SET price_cents = ? WHERE id = ?");
let changed = 0;
db.transaction(() => {
  for (const [id, cents] of rows) changed += update.run(cents, id).changes;
})();
console.log(`${changed} prices updated`);
