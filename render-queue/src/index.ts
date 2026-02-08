import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import jobs from "./routes/jobs";
import worker from "./routes/worker";

const app = new Hono<{ Bindings: Env }>();

// CORS for browser clients
app.use("/*", cors());

// Client-facing routes
app.route("/api/v1/jobs", jobs);

// GPU server routes (API key protected in the router)
app.route("/api/v1/worker", worker);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
