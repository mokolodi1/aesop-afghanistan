-- Shared family emails: allow multiple people rows per email when names differ.
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_email_key;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_email_unique;

CREATE UNIQUE INDEX IF NOT EXISTS people_email_name_unique
  ON people (lower(btrim(email)), lower(btrim(coalesce(name, ''))));
