-- Intra-day XP snapshots: one packed row per character per 3-hour UTC bucket.
-- The plugin used to upsert 24 skill rows on every skill sync (overwriting the
-- same UTC day). That was write-heavy and hid same-day progress. /sync now
-- writes at most eight of these rows per character per day.

CREATE TABLE IF NOT EXISTS player_xp_snapshots (
    rsn         text        NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    snapped_at  timestamptz NOT NULL,
    skills      jsonb       NOT NULL,
    PRIMARY KEY (rsn, snapped_at)
);

CREATE INDEX IF NOT EXISTS idx_player_xp_snapshots_rsn_time
    ON player_xp_snapshots (rsn, snapped_at DESC);

ALTER TABLE player_xp_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_xp_snapshots" ON player_xp_snapshots;
CREATE POLICY "owner_read_xp_snapshots" ON player_xp_snapshots
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

DROP POLICY IF EXISTS "public_read_xp_snapshots" ON player_xp_snapshots;
CREATE POLICY "public_read_xp_snapshots" ON player_xp_snapshots
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

REVOKE INSERT, UPDATE, DELETE ON player_xp_snapshots FROM anon, authenticated;
GRANT SELECT ON player_xp_snapshots TO anon, authenticated;

-- Fold existing daily per-skill rows into packed buckets (midnight UTC).
INSERT INTO player_xp_snapshots (rsn, snapped_at, skills)
SELECT
    rsn,
    (snap_date::timestamp AT TIME ZONE 'UTC') AS snapped_at,
    jsonb_object_agg(
        skill,
        jsonb_build_object('level', level, 'xp', xp)
    ) AS skills
FROM player_snapshots
GROUP BY rsn, snap_date
ON CONFLICT (rsn, snapped_at) DO NOTHING;

NOTIFY pgrst, 'reload schema';
