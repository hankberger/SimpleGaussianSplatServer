import type { JobRow, JobStatus, StageProgress, FeedItem } from "../types";

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

export async function incrementLikeCount(
  db: D1Database,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs SET like_count = like_count + 1
       WHERE id = ? AND status = 'completed'`
    )
    .bind(id)
    .run();
  return result.meta.changes > 0;
}
