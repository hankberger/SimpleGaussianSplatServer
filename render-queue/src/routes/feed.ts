import { Hono } from "hono";
import type { Env, AppVariables, FeedItem, FeedResponse, CommentItem, CommentsResponse } from "../types";
import { getFeedItems, getFeedCount, getUserPosts, getUserPostCount, incrementViewCount, insertLike, removeLike, getUserLikedPostIds, getComments, getTopLevelCommentCount, getReplies, insertComment, deleteComment } from "../db/queries";
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
  let likedPostIds = new Set<string>();
  if (userId) {
    likedPostIds = await getUserLikedPostIds(
      c.env.DB,
      userId,
      rows.map((r) => r.id)
    );
  }

  const items: FeedItem[] = rows.map((row) => ({
    post_id: row.id,
    job_id: row.id, // backward compat
    user_id: row.user_id,
    display_name: row.display_name,
    title: row.title,
    description: row.description,
    created_at: row.created_at,
    view_count: row.view_count,
    like_count: row.like_count,
    comment_count: row.comment_count ?? 0,
    splat_url: `${c.env.R2_PUBLIC_URL}/${row.result_key}`,
    liked_by_me: likedPostIds.has(row.id),
  }));

  const response: FeedResponse = { items, total, offset, limit };
  return c.json(response);
});

// GET /api/v1/feed/me — Return the authenticated user's own posts
feed.get("/me", requireAuth(), async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 50);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const userId = c.get("userId");

  const [rows, total] = await Promise.all([
    getUserPosts(c.env.DB, userId, limit, offset),
    getUserPostCount(c.env.DB, userId),
  ]);

  const likedPostIds = await getUserLikedPostIds(
    c.env.DB,
    userId,
    rows.map((r) => r.id)
  );

  const items: FeedItem[] = rows.map((row) => ({
    post_id: row.id,
    job_id: row.id,
    user_id: row.user_id,
    display_name: row.display_name,
    title: row.title,
    description: row.description,
    created_at: row.created_at,
    view_count: row.view_count,
    like_count: row.like_count,
    comment_count: row.comment_count ?? 0,
    splat_url: `${c.env.R2_PUBLIC_URL}/${row.result_key}`,
    liked_by_me: likedPostIds.has(row.id),
  }));

  return c.json({ items, total, offset, limit });
});

// POST /api/v1/feed/:id/view — Track a view (fire-and-forget)
feed.post("/:id/view", async (c) => {
  const postId = c.req.param("id");
  c.executionCtx.waitUntil(incrementViewCount(c.env.DB, postId));
  return c.json({ ok: true });
});

// POST /api/v1/feed/:id/like — Like a splat (requires auth)
feed.post("/:id/like", requireAuth(), async (c) => {
  const postId = c.req.param("id");
  const userId = c.get("userId");
  const inserted = await insertLike(c.env.DB, userId, postId);
  return c.json({ ok: true, already_liked: !inserted });
});

// DELETE /api/v1/feed/:id/like — Unlike a splat (requires auth)
feed.delete("/:id/like", requireAuth(), async (c) => {
  const postId = c.req.param("id");
  const userId = c.get("userId");
  const removed = await removeLike(c.env.DB, userId, postId);
  return c.json({ ok: true, was_liked: removed });
});

// GET /api/v1/feed/:id/comments — List threaded comments for a post
feed.get("/:id/comments", async (c) => {
  const postId = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const [rows, total] = await Promise.all([
    getComments(c.env.DB, postId, limit, offset),
    getTopLevelCommentCount(c.env.DB, postId),
  ]);

  const parentIds = rows.map((r) => r.id);
  const replyRows = await getReplies(c.env.DB, parentIds);

  // Group replies by parent_id
  const replyMap = new Map<string, CommentItem[]>();
  for (const r of replyRows) {
    const list = replyMap.get(r.parent_id!) || [];
    list.push({
      id: r.id,
      post_id: r.post_id,
      user_id: r.user_id,
      parent_id: r.parent_id,
      display_name: r.display_name,
      body: r.body,
      created_at: r.created_at,
      replies: [],
      reply_count: 0,
    });
    replyMap.set(r.parent_id!, list);
  }

  const comments: CommentItem[] = rows.map((row) => {
    const replies = replyMap.get(row.id) || [];
    return {
      id: row.id,
      post_id: row.post_id,
      user_id: row.user_id,
      parent_id: row.parent_id,
      display_name: row.display_name,
      body: row.body,
      created_at: row.created_at,
      replies,
      reply_count: replies.length,
    };
  });

  const response: CommentsResponse = { comments, total, offset, limit };
  return c.json(response);
});

// POST /api/v1/feed/:id/comments — Create a comment (requires auth)
feed.post("/:id/comments", requireAuth(), async (c) => {
  const postId = c.req.param("id");
  const userId = c.get("userId");
  const body = await c.req.json<{ body?: string; parent_id?: string }>();

  const text = body.body?.trim();
  if (!text || text.length === 0) {
    return c.json({ error: "Comment body is required" }, 400);
  }
  if (text.length > 1000) {
    return c.json({ error: "Comment must be 1000 characters or fewer" }, 400);
  }

  const id = crypto.randomUUID();
  const comment = await insertComment(c.env.DB, id, postId, userId, body.parent_id ?? null, text);

  const item: CommentItem = {
    id: comment.id,
    post_id: comment.post_id,
    user_id: comment.user_id,
    parent_id: comment.parent_id,
    display_name: comment.display_name,
    body: comment.body,
    created_at: comment.created_at,
    replies: [],
    reply_count: 0,
  };

  return c.json(item, 201);
});

// DELETE /api/v1/feed/:id/comments/:commentId — Delete own comment (requires auth)
feed.delete("/:id/comments/:commentId", requireAuth(), async (c) => {
  const commentId = c.req.param("commentId");
  const userId = c.get("userId");
  const result = await deleteComment(c.env.DB, commentId, userId);

  if (!result.deleted) {
    return c.json({ error: "Comment not found or not owned by you" }, 404);
  }

  return c.json({ ok: true, deleted_count: result.deletedCount });
});

export default feed;
