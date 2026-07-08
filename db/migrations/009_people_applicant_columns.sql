-- Applicant admissions + voice memo Drive metadata mirrored from Google Sheets/Drive.
ALTER TABLE people ADD COLUMN IF NOT EXISTS round1 VARCHAR(64);
ALTER TABLE people ADD COLUMN IF NOT EXISTS round2 VARCHAR(64);
ALTER TABLE people ADD COLUMN IF NOT EXISTS applicant_links TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS submitted_at VARCHAR(128);
ALTER TABLE people ADD COLUMN IF NOT EXISTS drive_file_id VARCHAR(128);
ALTER TABLE people ADD COLUMN IF NOT EXISTS drive_file_name VARCHAR(255);
ALTER TABLE people ADD COLUMN IF NOT EXISTS drive_duration_seconds INTEGER;
ALTER TABLE people ADD COLUMN IF NOT EXISTS applicants_synced_at TIMESTAMPTZ;
