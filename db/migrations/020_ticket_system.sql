CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  creator_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  subject VARCHAR(200) NOT NULL,
  category VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
  assigned_to_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  author_display_role VARCHAR(32) NOT NULL
    CHECK (author_display_role IN ('student', 'operations_team')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tickets_creator_updated_idx
  ON tickets (creator_person_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_status_last_message_idx
  ON tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_created_idx
  ON ticket_messages (ticket_id, created_at, id);

CREATE TABLE IF NOT EXISTS portal_ticket_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS portal_ticket_sessions_person_idx
  ON portal_ticket_sessions (person_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS portal_ticket_sessions_expiry_idx
  ON portal_ticket_sessions (expires_at);
