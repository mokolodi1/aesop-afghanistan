-- Mirror all People sheet columns into Postgres (typed fields + full row JSON).
ALTER TABLE people ADD COLUMN IF NOT EXISTS people_type TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS admin_role VARCHAR(64);
ALTER TABLE people ADD COLUMN IF NOT EXISTS people_status VARCHAR(64);
ALTER TABLE people ADD COLUMN IF NOT EXISTS last_login VARCHAR(128);
ALTER TABLE people ADD COLUMN IF NOT EXISTS past_ding TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS sheet_row JSONB;
