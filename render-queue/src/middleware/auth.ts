import type { Context, Next } from "hono";
import type { Env } from "../types";

export async function workerAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token !== c.env.WORKER_API_KEY) {
    return c.json({ error: "Invalid API key" }, 403);
  }

  await next();
}
