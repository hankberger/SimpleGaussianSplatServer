CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','processing','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Config
  output_format TEXT NOT NULL DEFAULT 'splat',
  max_frames INTEGER NOT NULL DEFAULT 40,
  training_iterations INTEGER NOT NULL DEFAULT 7000,
  resolution INTEGER NOT NULL DEFAULT 768,

  -- R2 keys
  video_key TEXT,
  result_key TEXT,

  -- Progress
  stages TEXT NOT NULL DEFAULT '[]',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
