-- Applicant age (Applicants sheet column L) for blind reviewer display.

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS age VARCHAR(32);
