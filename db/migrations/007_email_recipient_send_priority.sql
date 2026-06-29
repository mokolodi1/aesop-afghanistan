ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS send_priority smallint NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_priority_idx
  ON email_campaign_recipients (campaign_id, status, send_priority, id);
