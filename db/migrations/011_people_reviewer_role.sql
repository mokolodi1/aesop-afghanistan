-- Application reviewer flag from People sheet Reviewer column (mirrored hourly).
ALTER TABLE people ADD COLUMN IF NOT EXISTS reviewer_role VARCHAR(64);
