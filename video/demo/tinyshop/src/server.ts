import { login, userFor } from "./auth.ts";
import { checkout } from "./checkout.ts";
import { searchProducts } from "./db.ts";
import { HttpError } from "./errors.ts";
import { getOrder } from "./orders.ts";

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const user = userFor(req);

  if (req.method === "GET" && url.pathname === "/products") {
    return Response.json(searchProducts(url.searchParams.get("search") ?? ""));
  }
  const order = url.pathname.match(/^\/orders\/(\d+)$/);
  if (req.method === "GET" && order) {
    return Response.json(getOrder(Number(order[1]), user));
  }
  if (req.method === "POST" && url.pathname === "/checkout") {
    if (!user) throw new HttpError(401, "Sign in first");
    const { productId, qty } = await req.json();
    return Response.json(await checkout(user, productId, qty));
  }
  if (req.method === "POST" && url.pathname === "/login") {
    const { email, password } = await req.json();
    return Response.json({ token: await login(email, password) });
  }
  throw new HttpError(404, "Not found");
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err: any) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      console.error(err);
      const error = process.env.NODE_ENV === "production" ? "Internal error" : String(err.message);
      return Response.json({ error }, { status: 500 });
    }
  },
});
