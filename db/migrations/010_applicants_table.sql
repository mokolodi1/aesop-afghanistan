-- Mirror Google Sheets "Applicants" tab into a dedicated table (separate from people).
CREATE TABLE IF NOT EXISTS applicants (
  id SERIAL PRIMARY KEY,
  aesop_id VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(320),
  round1 VARCHAR(64),
  round2 VARCHAR(64),
  applicant_links TEXT,
  submitted_at VARCHAR(128),
  drive_file_id VARCHAR(128),
  drive_file_name VARCHAR(255),
  drive_duration_seconds INTEGER,
  synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS applicants_aesop_id_idx ON applicants (aesop_id);
CREATE INDEX IF NOT EXISTS applicants_email_idx ON applicants (email);

-- Move any applicant fields previously stored on people (migration 009).
INSERT INTO applicants (
  aesop_id,
  email,
  round1,
  round2,
  applicant_links,
  submitted_at,
  drive_file_id,
  drive_file_name,
  drive_duration_seconds,
  synced_at
)
SELECT
  aesop_id,
  email,
  round1,
  round2,
  applicant_links,
  submitted_at,
  drive_file_id,
  drive_file_name,
  drive_duration_seconds,
  COALESCE(applicants_synced_at, synced_at)
FROM people
WHERE aesop_id IS NOT NULL
  AND trim(aesop_id) <> ''
  AND (
    applicants_synced_at IS NOT NULL
    OR round1 IS NOT NULL
    OR round2 IS NOT NULL
    OR applicant_links IS NOT NULL
  )
ON CONFLICT (aesop_id) DO UPDATE SET
  email = EXCLUDED.email,
  round1 = EXCLUDED.round1,
  round2 = EXCLUDED.round2,
  applicant_links = EXCLUDED.applicant_links,
  submitted_at = EXCLUDED.submitted_at,
  drive_file_id = EXCLUDED.drive_file_id,
  drive_file_name = EXCLUDED.drive_file_name,
  drive_duration_seconds = EXCLUDED.drive_duration_seconds,
  synced_at = EXCLUDED.synced_at;

ALTER TABLE people DROP COLUMN IF EXISTS round1;
ALTER TABLE people DROP COLUMN IF EXISTS round2;
ALTER TABLE people DROP COLUMN IF EXISTS applicant_links;
ALTER TABLE people DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE people DROP COLUMN IF EXISTS drive_file_id;
ALTER TABLE people DROP COLUMN IF EXISTS drive_file_name;
ALTER TABLE people DROP COLUMN IF EXISTS drive_duration_seconds;
ALTER TABLE people DROP COLUMN IF EXISTS applicants_synced_at;
