import { jwt } from "hono/jwt";
import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../types";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export function requireAuth() {
  return async (c: Context<HonoEnv>, next: Next) => {
    const secret = c.env.JWT_SECRET;
    if (!secret) {
      return c.json({ error: "Auth not configured" }, 500);
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);
    try {
      // Use hono/jwt verify
      const jwtMiddleware = jwt({ secret });
      // We manually verify instead to extract payload
      const { verify } = await import("hono/jwt");
      const payload = await verify(token, secret) as { sub: string; email: string; exp: number };

      c.set("userId", payload.sub);
      c.set("userEmail", payload.email);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
  };
}

export function optionalAuth() {
  return async (c: Context<HonoEnv>, next: Next) => {
    const secret = c.env.JWT_SECRET;
    if (!secret) {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      await next();
      return;
    }

    const token = authHeader.slice(7);
    try {
      const { verify } = await import("hono/jwt");
      const payload = await verify(token, secret) as { sub: string; email: string; exp: number };

      c.set("userId", payload.sub);
      c.set("userEmail", payload.email);
    } catch {
      // Token invalid — continue without auth
    }

    await next();
  };
}
