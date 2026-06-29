-- CHAR(64) pads with spaces; use VARCHAR for content hashes.
ALTER TABLE email_admin_tests
  ALTER COLUMN content_hash TYPE VARCHAR(64);

ALTER TABLE email_campaigns
  ALTER COLUMN content_hash TYPE VARCHAR(64);
