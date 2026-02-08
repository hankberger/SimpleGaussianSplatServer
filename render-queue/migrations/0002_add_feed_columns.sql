ALTER TABLE jobs ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_jobs_feed ON jobs(status, view_count, created_at);
