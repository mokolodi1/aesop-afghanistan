-- ApplicantReviews sheet: A/B Unable to Grade + Technical Flag columns.

ALTER TABLE applicant_reviews ADD COLUMN IF NOT EXISTS a_unable_to_grade VARCHAR(32);
ALTER TABLE applicant_reviews ADD COLUMN IF NOT EXISTS a_technical_flag VARCHAR(128);
ALTER TABLE applicant_reviews ADD COLUMN IF NOT EXISTS b_unable_to_grade VARCHAR(32);
ALTER TABLE applicant_reviews ADD COLUMN IF NOT EXISTS b_technical_flag VARCHAR(128);

ALTER TABLE applicant_reviews_staging ADD COLUMN IF NOT EXISTS a_unable_to_grade VARCHAR(32);
ALTER TABLE applicant_reviews_staging ADD COLUMN IF NOT EXISTS a_technical_flag VARCHAR(128);
ALTER TABLE applicant_reviews_staging ADD COLUMN IF NOT EXISTS b_unable_to_grade VARCHAR(32);
ALTER TABLE applicant_reviews_staging ADD COLUMN IF NOT EXISTS b_technical_flag VARCHAR(128);
