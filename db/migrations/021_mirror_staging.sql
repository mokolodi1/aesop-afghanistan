-- Staging tables for interrupt-safe hourly mirror refresh.
-- Production tables are updated atomically via promoteStagingMirror().

CREATE TABLE IF NOT EXISTS mirror_sync_runs (
  id SERIAL PRIMARY KEY,
  job_run_id INTEGER REFERENCES job_runs(id),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL,
  people_count INTEGER,
  ding_count INTEGER,
  applicants_count INTEGER,
  applicant_reviews_count INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS mirror_sync_runs_status_finished_idx
  ON mirror_sync_runs (status, finished_at DESC);

CREATE TABLE IF NOT EXISTS people_staging (
  identity_key VARCHAR(512) NOT NULL PRIMARY KEY,
  aesop_id VARCHAR(64),
  email VARCHAR(320) NOT NULL,
  name VARCHAR(255),
  phone VARCHAR(64),
  portal_role VARCHAR(20),
  reviewer_role VARCHAR(64),
  people_type TEXT,
  admin_role VARCHAR(64),
  people_status VARCHAR(64),
  last_login VARCHAR(128),
  past_ding TEXT,
  sheet_row JSONB
);

CREATE TABLE IF NOT EXISTS ding_numbers_staging (
  identity_key VARCHAR(512) NOT NULL PRIMARY KEY,
  number VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS applicants_staging (
  aesop_id VARCHAR(64) NOT NULL PRIMARY KEY,
  email VARCHAR(320),
  name VARCHAR(255),
  applied_level VARCHAR(64),
  age VARCHAR(64),
  essay TEXT,
  round1 VARCHAR(64),
  round2 VARCHAR(64),
  round2_prompt TEXT,
  applicant_links TEXT,
  submitted_at VARCHAR(128),
  drive_file_id VARCHAR(128),
  drive_file_name VARCHAR(255),
  drive_duration_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS applicant_reviews_staging (
  aesop_id VARCHAR(64) NOT NULL PRIMARY KEY,
  reviewer_a VARCHAR(64),
  reviewer_b VARCHAR(64),
  a_english_level VARCHAR(32),
  a_suspected_ai VARCHAR(32),
  a_instruction_following VARCHAR(32),
  a_original_thinking VARCHAR(32),
  a_character VARCHAR(32),
  b_english_level VARCHAR(32),
  b_suspected_ai VARCHAR(32),
  b_instruction_following VARCHAR(32),
  b_original_thinking VARCHAR(32),
  b_character VARCHAR(32),
  sheet_row_number INTEGER
);
