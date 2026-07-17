-- Daily XP snapshots (foundation for gains graphs and "what have you been
-- training" heuristics) + realtime publication so the website can subscribe to
-- live changes instead of polling.

CREATE TABLE IF NOT EXISTS player_snapshots (
    rsn        text   NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    snap_date  date   NOT NULL,
    skill      text   NOT NULL,
    level      int    NOT NULL,
    xp         bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, snap_date, skill)
);

-- Time-series reads: "xp for skill X over the last N days"
CREATE INDEX IF NOT EXISTS idx_player_snapshots_rsn_skill
    ON player_snapshots (rsn, skill, snap_date DESC);

ALTER TABLE player_snapshots ENABLE ROW LEVEL SECURITY;

-- Same visibility model as player_skills: owners always, public profiles for everyone
CREATE POLICY "owner_read_snapshots" ON player_snapshots
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

CREATE POLICY "public_read_snapshots" ON player_snapshots
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

-- Writes only via Edge Functions (service role)
REVOKE INSERT, UPDATE, DELETE ON player_snapshots FROM anon, authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- postgres_changes subscriptions respect RLS, so subscribers only receive rows
-- their role could SELECT. Idempotent: adding a table twice raises, so guard.

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE players;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_skills;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_quests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
