CREATE TABLE IF NOT EXISTS voice_memo_audio (
  drive_file_id VARCHAR(128) PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  size_bytes INTEGER NOT NULL,
  content BYTEA NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS voice_memo_audio_cached_at_idx ON voice_memo_audio (cached_at);
