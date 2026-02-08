import type { JobRow, JobStatus, StageProgress, FeedItem, UserRow } from "../types";

export async function insertJob(
  db: D1Database,
  id: string,
  videoKey: string,
  config: {
    output_format: string;
    max_frames: number;
    training_iterations: number;
    resolution: number;
  }
): Promise<void> {
  const stages: StageProgress[] = [
    { name: "frame_extraction", status: "pending" },
    { name: "pose_estimation", status: "pending" },
    { name: "training", status: "pending" },
    { name: "conversion", status: "pending" },
  ];

  await db
    .prepare(
      `INSERT INTO jobs (id, video_key, output_format, max_frames, training_iterations, resolution, stages)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      videoKey,
      config.output_format,
      config.max_frames,
      config.training_iterations,
      config.resolution,
      JSON.stringify(stages)
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

  return result.meta.changes > 0;
}

export async function getFeedItems(
  db: D1Database,
  limit: number,
  offset: number
): Promise<JobRow[]> {
  const results = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'completed' AND result_key IS NOT NULL
       ORDER BY (
         view_count * 0.3
         + like_count * 1.0
         + (86400.0 / (strftime('%s','now') - strftime('%s',created_at) + 3600))
       ) DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<JobRow>();
  return results.results;
}

export async function getFeedCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM jobs
       WHERE status = 'completed' AND result_key IS NOT NULL`
    )
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function incrementViewCount(
  db: D1Database,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs SET view_count = view_count + 1
       WHERE id = ? AND status = 'completed'`
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
  jobId: string
): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO likes (user_id, job_id) VALUES (?, ?)")
      .bind(userId, jobId)
      .run();
    // Increment denormalized like_count
    await db
      .prepare(
        `UPDATE jobs SET like_count = like_count + 1
         WHERE id = ? AND status = 'completed'`
      )
      .bind(jobId)
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
  jobId: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM likes WHERE user_id = ? AND job_id = ?")
    .bind(userId, jobId)
    .run();
  if (result.meta.changes > 0) {
    await db
      .prepare(
        `UPDATE jobs SET like_count = MAX(0, like_count - 1)
         WHERE id = ? AND status = 'completed'`
      )
      .bind(jobId)
      .run();
    return true;
  }
  return false;
}

export async function getUserLikedJobIds(
  db: D1Database,
  userId: string,
  jobIds: string[]
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const placeholders = jobIds.map(() => "?").join(",");
  const results = await db
    .prepare(
      `SELECT job_id FROM likes WHERE user_id = ? AND job_id IN (${placeholders})`
    )
    .bind(userId, ...jobIds)
    .all<{ job_id: string }>();
  return new Set(results.results.map((r) => r.job_id));
}
