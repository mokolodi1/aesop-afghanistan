ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
