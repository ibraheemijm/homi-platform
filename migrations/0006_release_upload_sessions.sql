CREATE TABLE IF NOT EXISTS release_upload_sessions (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES product_releases(id),
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  platform_key TEXT NOT NULL CHECK (platform_key IN ('android', 'windows', 'linux')),
  architecture_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256_hex TEXT NOT NULL CHECK (length(sha256_hex) = 64),
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'completed', 'failed', 'aborted')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_upload_parts (
  upload_session_id TEXT NOT NULL REFERENCES release_upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(upload_session_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_release_upload_sessions_release
  ON release_upload_sessions(release_id, status, created_at DESC);
