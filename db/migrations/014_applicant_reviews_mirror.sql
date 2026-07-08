-- Review-specific applicant fields + ApplicantReviews sheet mirror for reviewer portal.

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS applied_level VARCHAR(64);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS essay TEXT;

CREATE TABLE IF NOT EXISTS applicant_reviews (
  id SERIAL PRIMARY KEY,
  aesop_id VARCHAR(64) NOT NULL UNIQUE,
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
  sheet_row_number INTEGER,
  synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS applicant_reviews_reviewer_a_idx ON applicant_reviews (reviewer_a);
CREATE INDEX IF NOT EXISTS applicant_reviews_reviewer_b_idx ON applicant_reviews (reviewer_b);
CREATE INDEX IF NOT EXISTS applicant_reviews_synced_at_idx ON applicant_reviews (synced_at);
