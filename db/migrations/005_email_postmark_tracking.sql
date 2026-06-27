ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS postmark_message_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS email_campaign_recipients_postmark_message_id_idx
  ON email_campaign_recipients (postmark_message_id);
