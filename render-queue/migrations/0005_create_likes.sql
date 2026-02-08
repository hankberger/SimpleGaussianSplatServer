CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL REFERENCES users(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_job_id ON likes(job_id);
CREATE INDEX IF NOT EXISTS idx_likes_user_id ON likes(user_id);
