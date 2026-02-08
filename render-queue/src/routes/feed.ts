import { Hono } from "hono";
import type { Env, FeedItem, FeedResponse } from "../types";
import { getFeedItems, getFeedCount, incrementViewCount, incrementLikeCount } from "../db/queries";

const feed = new Hono<{ Bindings: Env }>();

// GET /api/v1/feed?limit=10&offset=0 — Return recommended feed of completed splats
feed.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 50);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const [rows, total] = await Promise.all([
    getFeedItems(c.env.DB, limit, offset),
    getFeedCount(c.env.DB),
  ]);

  const items: FeedItem[] = rows.map((row) => ({
    job_id: row.id,
    created_at: row.created_at,
    view_count: row.view_count,
    like_count: row.like_count,
    splat_url: `${c.env.R2_PUBLIC_URL}/${row.result_key}`,
  }));

  const response: FeedResponse = { items, total, offset, limit };
  return c.json(response);
});

// POST /api/v1/feed/:id/view — Track a view (fire-and-forget)
feed.post("/:id/view", async (c) => {
  const jobId = c.req.param("id");
  c.executionCtx.waitUntil(incrementViewCount(c.env.DB, jobId));
  return c.json({ ok: true });
});

// POST /api/v1/feed/:id/like — Increment like count
feed.post("/:id/like", async (c) => {
  const jobId = c.req.param("id");
  c.executionCtx.waitUntil(incrementLikeCount(c.env.DB, jobId));
  return c.json({ ok: true });
});

export default feed;
