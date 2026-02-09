import type { JobRow, JobStatus, StageProgress, FeedItem, UserRow, PostRow, CommentRow } from "../types";

export async function insertJob(
  db: D1Database,
  id: string,
  videoKey: string,
  config: {
    output_format: string;
    max_frames: number;
    training_iterations: number;
    resolution: number;
  },
  userId?: string | null
): Promise<void> {
  const stages: StageProgress[] = [
    { name: "frame_extraction", status: "pending" },
    { name: "pose_estimation", status: "pending" },
    { name: "training", status: "pending" },
    { name: "conversion", status: "pending" },
  ];

  await db
    .prepare(
      `INSERT INTO jobs (id, video_key, output_format, max_frames, training_iterations, resolution, stages, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      videoKey,
      config.output_format,
      config.max_frames,
      config.training_iterations,
      config.resolution,
      JSON.stringify(stages),
      userId ?? null
    )
    .run();
}

export async function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  const result = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return result ?? null;
}

export async function claimOldestJob(db: D1Database): Promise<JobRow | null> {
  // Atomically claim the oldest queued job
  const result = await db
    .prepare(
      `UPDATE jobs
       SET status = 'claimed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
       )
       RETURNING *`
    )
    .first<JobRow>();
  return result ?? null;
}

export async function updateJobStatus(
  db: D1Database,
  id: string,
  status: JobStatus,
  stages?: StageProgress[],
  error?: string
): Promise<boolean> {
  const parts = [
    "status = ?",
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  ];
  const binds: (string | null)[] = [status];

  if (stages !== undefined) {
    parts.push("stages = ?");
    binds.push(JSON.stringify(stages));
  }
  if (error !== undefined) {
    parts.push("error = ?");
    binds.push(error);
  }

  binds.push(id);

  const result = await db
    .prepare(`UPDATE jobs SET ${parts.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  return result.meta.changes > 0;
}

export async function setJobResultKey(
  db: D1Database,
  id: string,
  resultKey: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs SET result_key = ?, status = 'completed',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
    .bind(resultKey, id)
    .run();

  if (result.meta.changes > 0) {
    // Create a corresponding post row
    const job = await db
      .prepare("SELECT id, user_id, output_format FROM jobs WHERE id = ?")
      .bind(id)
      .first<{ id: string; user_id: string | null; output_format: string }>();

    if (job) {
      await db
        .prepare(
          `INSERT INTO posts (id, user_id, result_key, output_format)
           VALUES (?, ?, ?, ?)`
        )
        .bind(job.id, job.user_id, resultKey, job.output_format)
        .run();
    }
    return true;
  }

  return false;
}

export interface PostWithAuthor extends PostRow {
  display_name: string | null;
}

export async function getFeedItems(
  db: D1Database,
  limit: number,
  offset: number
): Promise<PostWithAuthor[]> {
  const results = await db
    .prepare(
      `SELECT p.*, u.display_name
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       ORDER BY (
         p.view_count * 0.3
         + p.like_count * 1.0
         + (86400.0 / (strftime('%s','now') - strftime('%s',p.created_at) + 3600))
       ) DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<PostWithAuthor>();
  return results.results;
}

export async function getFeedCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM posts")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function incrementViewCount(
  db: D1Database,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE posts SET view_count = view_count + 1 WHERE id = ?"
    )
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

// ---- User queries ----

export async function insertUser(
  db: D1Database,
  user: {
    id: string;
    email: string;
    password_hash: string | null;
    salt: string | null;
    provider: string;
    provider_id: string | null;
    display_name: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, salt, provider, provider_id, display_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      user.id,
      user.email,
      user.password_hash,
      user.salt,
      user.provider,
      user.provider_id,
      user.display_name
    )
    .run();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  return result ?? null;
}

export async function getUserByProvider(
  db: D1Database,
  provider: string,
  providerId: string
): Promise<UserRow | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?")
    .bind(provider, providerId)
    .first<UserRow>();
  return result ?? null;
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const result = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  return result ?? null;
}

// ---- Like queries ----

export async function insertLike(
  db: D1Database,
  userId: string,
  postId: string
): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO likes (user_id, job_id, post_id) VALUES (?, ?, ?)")
      .bind(userId, postId, postId)
      .run();
    // Increment denormalized like_count on posts
    await db
      .prepare(
        "UPDATE posts SET like_count = like_count + 1 WHERE id = ?"
      )
      .bind(postId)
      .run();
    return true;
  } catch (e: any) {
    // UNIQUE constraint violation = already liked, treat as no-op
    if (e.message?.includes("UNIQUE")) return false;
    throw e;
  }
}

export async function removeLike(
  db: D1Database,
  userId: string,
  postId: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM likes WHERE user_id = ? AND post_id = ?")
    .bind(userId, postId)
    .run();
  if (result.meta.changes > 0) {
    await db
      .prepare(
        "UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?"
      )
      .bind(postId)
      .run();
    return true;
  }
  return false;
}

export async function getUserPosts(
  db: D1Database,
  userId: string,
  limit: number,
  offset: number
): Promise<PostWithAuthor[]> {
  const results = await db
    .prepare(
      `SELECT p.*, u.display_name
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(userId, limit, offset)
    .all<PostWithAuthor>();
  return results.results;
}

export async function getUserPostCount(
  db: D1Database,
  userId: string
): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM posts WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function getUserLikedPostIds(
  db: D1Database,
  userId: string,
  postIds: string[]
): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const placeholders = postIds.map(() => "?").join(",");
  const results = await db
    .prepare(
      `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`
    )
    .bind(userId, ...postIds)
    .all<{ post_id: string }>();
  return new Set(results.results.map((r) => r.post_id));
}

// ---- Comment queries ----

interface CommentWithAuthor extends CommentRow {
  display_name: string | null;
}

export async function getComments(
  db: D1Database,
  postId: string,
  limit: number,
  offset: number
): Promise<CommentWithAuthor[]> {
  const results = await db
    .prepare(
      `SELECT c.*, u.display_name
       FROM comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ? AND c.parent_id IS NULL
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`
    )
    .bind(postId, limit, offset)
    .all<CommentWithAuthor>();
  return results.results;
}

export async function getTopLevelCommentCount(
  db: D1Database,
  postId: string
): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM comments WHERE post_id = ? AND parent_id IS NULL")
    .bind(postId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function getReplies(
  db: D1Database,
  parentIds: string[]
): Promise<CommentWithAuthor[]> {
  if (parentIds.length === 0) return [];
  const placeholders = parentIds.map(() => "?").join(",");
  const results = await db
    .prepare(
      `SELECT c.*, u.display_name
       FROM comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.parent_id IN (${placeholders})
       ORDER BY c.created_at ASC`
    )
    .bind(...parentIds)
    .all<CommentWithAuthor>();
  return results.results;
}

export async function insertComment(
  db: D1Database,
  id: string,
  postId: string,
  userId: string,
  parentId: string | null,
  body: string
): Promise<CommentWithAuthor> {
  // Flatten reply-to-reply: if parentId points to a reply, use its parent instead
  let resolvedParentId = parentId;
  if (parentId) {
    const parent = await db
      .prepare("SELECT id, parent_id FROM comments WHERE id = ?")
      .bind(parentId)
      .first<{ id: string; parent_id: string | null }>();
    if (parent?.parent_id) {
      resolvedParentId = parent.parent_id;
    }
  }

  const comment = await db
    .prepare(
      `INSERT INTO comments (id, post_id, user_id, parent_id, body)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(id, postId, userId, resolvedParentId, body)
    .first<CommentRow>();

  // Increment denormalized comment_count on posts
  await db
    .prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?")
    .bind(postId)
    .run();

  // Fetch display_name
  const user = await db
    .prepare("SELECT display_name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ display_name: string | null }>();

  return { ...comment!, display_name: user?.display_name ?? null };
}

export async function deleteComment(
  db: D1Database,
  commentId: string,
  userId: string
): Promise<{ deleted: boolean; deletedCount: number }> {
  // Ownership check
  const comment = await db
    .prepare("SELECT id, post_id, user_id, parent_id FROM comments WHERE id = ?")
    .bind(commentId)
    .first<{ id: string; post_id: string; user_id: string; parent_id: string | null }>();

  if (!comment || comment.user_id !== userId) {
    return { deleted: false, deletedCount: 0 };
  }

  let deletedCount = 1;

  // If top-level, cascade-delete replies
  if (!comment.parent_id) {
    const replyResult = await db
      .prepare("DELETE FROM comments WHERE parent_id = ?")
      .bind(commentId)
      .run();
    deletedCount += replyResult.meta.changes;
  }

  // Delete the comment itself
  await db.prepare("DELETE FROM comments WHERE id = ?").bind(commentId).run();

  // Decrement posts.comment_count
  await db
    .prepare(
      "UPDATE posts SET comment_count = MAX(0, comment_count - ?) WHERE id = ?"
    )
    .bind(deletedCount, comment.post_id)
    .run();

  return { deleted: true, deletedCount };
}
