-- Track the rendered scene preview (WebP) so clients can show a thumbnail
-- without downloading the full splat. Stored in R2 alongside the result.
ALTER TABLE jobs ADD COLUMN preview_key TEXT;
ALTER TABLE posts ADD COLUMN preview_key TEXT;
