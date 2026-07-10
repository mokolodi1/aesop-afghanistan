-- Round 2 voice note prompt (Applicants sheet "Round 2 Prompt" column) for portal display.

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS round2_prompt TEXT;
