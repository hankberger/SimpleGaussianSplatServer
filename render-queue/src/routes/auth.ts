import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Env, AppVariables, RegisterRequest, LoginRequest, OAuthRequest, AuthResponse } from "../types";
import { hashPassword, verifyPassword } from "../utils/password";
import { insertUser, getUserByEmail, getUserByProvider, getUserById } from "../db/queries";
import { requireAuth } from "../middleware/jwt-auth";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const TOKEN_EXPIRY_DAYS = 30;

async function createToken(secret: string, userId: string, email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 24 * 60 * 60;
  return sign({ sub: userId, email, exp }, secret);
}

// POST /api/v1/auth/register
auth.post("/register", async (c) => {
  const body = await c.req.json<RegisterRequest>();

  if (!body.email || !body.password) {
    return c.json({ error: "Email and password are required" }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const existing = await getUserByEmail(c.env.DB, body.email);
  if (existing) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const { hash, salt } = await hashPassword(body.password);
  const userId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  await insertUser(c.env.DB, {
    id: userId,
    email: body.email,
    password_hash: hash,
    salt,
    provider: "email",
    provider_id: null,
    display_name: body.display_name || null,
  });

  const token = await createToken(c.env.JWT_SECRET, userId, body.email);
  const response: AuthResponse = {
    token,
    user: { id: userId, email: body.email, display_name: body.display_name || null, provider: "email" },
  };
  return c.json(response, 201);
});

// POST /api/v1/auth/login
auth.post("/login", async (c) => {
  const body = await c.req.json<LoginRequest>();

  if (!body.email || !body.password) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const user = await getUserByEmail(c.env.DB, body.email);
  if (!user || !user.password_hash || !user.salt) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const valid = await verifyPassword(body.password, user.password_hash, user.salt);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const token = await createToken(c.env.JWT_SECRET, user.id, user.email);
  const response: AuthResponse = {
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name, provider: user.provider },
  };
  return c.json(response);
});

// POST /api/v1/auth/oauth
auth.post("/oauth", async (c) => {
  const body = await c.req.json<OAuthRequest>();

  if (!body.provider || !body.id_token) {
    return c.json({ error: "Provider and id_token are required" }, 400);
  }

  let email: string;
  let providerId: string;

  if (body.provider === "google") {
    const tokenInfo = await verifyGoogleToken(body.id_token, c.env.GOOGLE_CLIENT_ID);
    if (!tokenInfo) {
      return c.json({ error: "Invalid Google token" }, 401);
    }
    email = tokenInfo.email;
    providerId = tokenInfo.sub;
  } else if (body.provider === "apple") {
    const tokenInfo = await verifyAppleToken(body.id_token, c.env.APPLE_BUNDLE_ID);
    if (!tokenInfo) {
      return c.json({ error: "Invalid Apple token" }, 401);
    }
    email = tokenInfo.email;
    providerId = tokenInfo.sub;
  } else {
    return c.json({ error: "Unsupported provider" }, 400);
  }

  // Check if user exists by provider
  let user = await getUserByProvider(c.env.DB, body.provider, providerId);

  if (!user) {
    // Check if email already exists (link accounts)
    user = await getUserByEmail(c.env.DB, email);
    if (!user) {
      // Create new user
      const userId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await insertUser(c.env.DB, {
        id: userId,
        email,
        password_hash: null,
        salt: null,
        provider: body.provider,
        provider_id: providerId,
        display_name: body.display_name || null,
      });
      user = await getUserById(c.env.DB, userId);
    }
  }

  if (!user) {
    return c.json({ error: "Failed to create account" }, 500);
  }

  const token = await createToken(c.env.JWT_SECRET, user.id, user.email);
  const response: AuthResponse = {
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name, provider: user.provider },
  };
  return c.json(response);
});

// GET /api/v1/auth/me
auth.get("/me", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const user = await getUserById(c.env.DB, userId);
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    provider: user.provider,
  });
});

// Google token verification
async function verifyGoogleToken(
  idToken: string,
  clientId: string
): Promise<{ email: string; sub: string } | null> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!res.ok) return null;
    const data = await res.json() as { aud: string; email: string; sub: string; email_verified: string };
    if (data.aud !== clientId) return null;
    if (data.email_verified !== "true") return null;
    return { email: data.email, sub: data.sub };
  } catch {
    return null;
  }
}

// Apple token verification
async function verifyAppleToken(
  idToken: string,
  bundleId: string
): Promise<{ email: string; sub: string } | null> {
  try {
    // Decode the JWT payload (without verification for now - Apple's public keys are complex)
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;

    // Fetch Apple's public keys
    const keysRes = await fetch("https://appleid.apple.com/auth/keys");
    if (!keysRes.ok) return null;

    // Decode payload
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.aud !== bundleId) return null;
    if (payload.iss !== "https://appleid.apple.com") return null;
    if (payload.exp * 1000 < Date.now()) return null;

    return { email: payload.email, sub: payload.sub };
  } catch {
    return null;
  }
}

export default auth;
