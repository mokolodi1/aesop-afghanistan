-- Job run records for the scheduled/on-demand sync jobs (Jobs tab in the
-- admin portal). One row per run, including captured console logs.

CREATE TABLE IF NOT EXISTS job_runs (
  id SERIAL PRIMARY KEY,
  job_name VARCHAR(64) NOT NULL,
  -- 'schedule' (Supercronic) or 'admin' (Jobs tab button)
  trigger_source VARCHAR(16) NOT NULL DEFAULT 'schedule',
  -- admin email for trigger_source='admin'
  triggered_by VARCHAR(320),
  -- running | succeeded | failed | skipped
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  -- job summary (counts etc.) as returned by the job function
  result JSONB,
  error TEXT,
  -- captured console output (tail-truncated for very long runs)
  logs TEXT
);

CREATE INDEX IF NOT EXISTS job_runs_job_name_started_at_idx
  ON job_runs (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_status_idx
  ON job_runs (status);
