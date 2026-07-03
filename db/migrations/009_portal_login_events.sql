CREATE TABLE IF NOT EXISTS portal_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,
  aesop_id VARCHAR(64),
  email VARCHAR(320),
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_events_type_created_idx ON portal_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_events_aesop_id_idx ON portal_events (aesop_id);
CREATE INDEX IF NOT EXISTS portal_events_person_id_idx ON portal_events (person_id);

ALTER TABLE people ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE people ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS people_last_login_at_idx ON people (last_login_at);
