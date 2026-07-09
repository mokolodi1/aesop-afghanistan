CREATE TABLE IF NOT EXISTS portal_metric_buckets (
  bucket_start TIMESTAMPTZ NOT NULL,
  metric TEXT NOT NULL,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  value DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, metric, labels)
);

CREATE INDEX IF NOT EXISTS portal_metric_buckets_metric_time_idx
  ON portal_metric_buckets (metric, bucket_start DESC);
