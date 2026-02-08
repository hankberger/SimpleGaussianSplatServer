import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppVariables } from "./types";
import jobs from "./routes/jobs";
import worker from "./routes/worker";
import feed from "./routes/feed";
import auth from "./routes/auth";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// CORS for browser clients
app.use("/*", cors());

// Client-facing routes
app.route("/api/v1/jobs", jobs);

// Feed routes (recommendation feed)
app.route("/api/v1/feed", feed);

// Auth routes
app.route("/api/v1/auth", auth);

// GPU server routes (API key protected in the router)
app.route("/api/v1/worker", worker);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
