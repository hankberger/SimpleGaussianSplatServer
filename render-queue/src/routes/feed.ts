import { Hono } from "hono";
import type { Env, AppVariables, FeedItem, FeedResponse } from "../types";
import { getFeedItems, getFeedCount, incrementViewCount, insertLike, removeLike, getUserLikedJobIds } from "../db/queries";
import { optionalAuth, requireAuth } from "../middleware/jwt-auth";

const feed = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/v1/feed?limit=10&offset=0 — Return recommended feed of completed splats
feed.get("/", optionalAuth(), async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 50);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const [rows, total] = await Promise.all([
    getFeedItems(c.env.DB, limit, offset),
    getFeedCount(c.env.DB),
  ]);

  const userId = c.get("userId");
  let likedJobIds = new Set<string>();
  if (userId) {
    likedJobIds = await getUserLikedJobIds(
      c.env.DB,
      userId,
      rows.map((r) => r.id)
    );
  }

  const items: FeedItem[] = rows.map((row) => ({
    job_id: row.id,
    created_at: row.created_at,
    view_count: row.view_count,
    like_count: row.like_count,
    splat_url: `${c.env.R2_PUBLIC_URL}/${row.result_key}`,
    liked_by_me: likedJobIds.has(row.id),
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

// POST /api/v1/feed/:id/like — Like a splat (requires auth)
feed.post("/:id/like", requireAuth(), async (c) => {
  const jobId = c.req.param("id");
  const userId = c.get("userId");
  const inserted = await insertLike(c.env.DB, userId, jobId);
  return c.json({ ok: true, already_liked: !inserted });
});

// DELETE /api/v1/feed/:id/like — Unlike a splat (requires auth)
feed.delete("/:id/like", requireAuth(), async (c) => {
  const jobId = c.req.param("id");
  const userId = c.get("userId");
  const removed = await removeLike(c.env.DB, userId, jobId);
  return c.json({ ok: true, was_liked: removed });
});

export default feed;
