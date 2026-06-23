CREATE TABLE IF NOT EXISTS magic_links (
  token CHAR(64) PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  user_id VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS magic_links_expires_at_idx ON magic_links (expires_at);
