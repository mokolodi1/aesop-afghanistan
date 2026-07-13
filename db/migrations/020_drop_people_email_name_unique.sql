-- People rows are keyed by AESOP ID (unique). Email and name may repeat across rows.
DROP INDEX IF EXISTS people_email_name_unique;
