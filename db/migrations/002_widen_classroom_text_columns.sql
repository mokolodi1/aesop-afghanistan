-- Google Classroom course labels and assignment titles can exceed 512 characters.
ALTER TABLE courses ALTER COLUMN label TYPE TEXT;
ALTER TABLE assignments ALTER COLUMN title TYPE TEXT;
