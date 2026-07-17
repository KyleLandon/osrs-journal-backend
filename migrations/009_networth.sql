-- Net worth history: one GE-estimated bank value per character per day.
--
-- Written only by the /networth Edge Function (service role) after verifying
-- the caller's JWT owns the character. Readable only by the owner — never
-- public, even for public profiles, because the value is derived from private
-- bank contents.

CREATE TABLE IF NOT EXISTS player_networth (
    rsn        text   NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    snap_date  date   NOT NULL,
    value      bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, snap_date)
);

ALTER TABLE player_networth ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_networth" ON player_networth;
CREATE POLICY "owner_read_networth" ON player_networth
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

-- Clients never write directly; the Edge Function uses the service role.
REVOKE INSERT, UPDATE, DELETE ON player_networth FROM anon, authenticated;
