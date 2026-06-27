CREATE TABLE IF NOT EXISTS email_admin_tests (
  admin_email VARCHAR(320) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  test_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_sent_to VARCHAR(320) NOT NULL,
  PRIMARY KEY (admin_email, content_hash)
);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id SERIAL PRIMARY KEY,
  created_by_email VARCHAR(320) NOT NULL,
  recipient_group VARCHAR(64) NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  global_vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipient_filter JSONB,
  content_hash CHAR(64) NOT NULL,
  test_sent_at TIMESTAMPTZ,
  test_sent_to VARCHAR(320),
  status VARCHAR(20) NOT NULL DEFAULT 'sending',
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  next_batch_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_campaigns_status_next_batch_idx
  ON email_campaigns (status, next_batch_at);

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES email_campaigns (id) ON DELETE CASCADE,
  aesop_id VARCHAR(64),
  name VARCHAR(255),
  email VARCHAR(320) NOT NULL,
  row_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  error TEXT,
  batch_number INTEGER
);

CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_status_idx
  ON email_campaign_recipients (campaign_id, status);
