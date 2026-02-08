CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  result_key TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT 'splat',
  title TEXT,
  description TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_feed ON posts(view_count, like_count, created_at);

-- Backfill existing completed jobs into posts
-- Only reference columns from v1 schema; view_count/like_count default to 0
INSERT INTO posts (id, result_key, output_format, created_at, updated_at)
SELECT id, result_key, output_format, created_at, updated_at
FROM jobs WHERE status = 'completed' AND result_key IS NOT NULL;

-- Add post_id to likes (can't drop job_id or change PK in SQLite)
ALTER TABLE likes ADD COLUMN post_id TEXT REFERENCES posts(id);
UPDATE likes SET post_id = job_id WHERE job_id IN (SELECT id FROM posts);

-- Track uploader on jobs going forward
ALTER TABLE jobs ADD COLUMN user_id TEXT REFERENCES users(id);
