-- Simple sliding-window rate limit buckets for Edge Functions

CREATE TABLE IF NOT EXISTS rate_limit_events (
    id          bigserial   PRIMARY KEY,
    bucket      text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_bucket_time
    ON rate_limit_events (bucket, created_at DESC);

ALTER TABLE rate_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_direct_rate_limit_access" ON rate_limit_events
    FOR ALL TO anon, authenticated
    USING (false);
