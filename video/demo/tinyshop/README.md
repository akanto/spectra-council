# tinyshop

A tiny HTTP API for a shop, written for Bun with `bun:sqlite`.

## Run

    bun install
    bun run start    # listens on PORT (default 3000)
    bun test

## Routes

- `GET /products?search=` lists products whose name matches
- `GET /orders/:id` returns an order (needs a bearer token)
- `POST /checkout` with `{ "productId", "qty" }` buys a product
- `POST /login` with `{ "email", "password" }` returns a token

## Prices

Prices change only through `bun scripts/reprice.ts prices.csv`, which runs as
part of a deploy. The deploy restarts the server.
