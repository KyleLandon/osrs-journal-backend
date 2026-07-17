-- Short-lived read sessions for the bundled localhost journal (opened from RuneLite)

CREATE TABLE IF NOT EXISTS localhost_sessions (
    token       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    rsn         text        NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_localhost_sessions_expires ON localhost_sessions(expires_at);

ALTER TABLE localhost_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_direct_localhost_sessions" ON localhost_sessions
    FOR ALL TO anon, authenticated
    USING (false);
