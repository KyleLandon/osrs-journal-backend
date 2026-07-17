-- Goals (website planner), achievement diaries, and combat achievement tiers.
-- Goals are written via the /goals Edge Function (JWT + ownership).
-- Diaries/CA are written by the plugin via /sync (X-Sync-Token).

CREATE TABLE IF NOT EXISTS player_goals (
    rsn        text PRIMARY KEY REFERENCES players(rsn) ON DELETE CASCADE,
    goals      jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_diaries (
    rsn        text NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    region     text NOT NULL,
    tier       text NOT NULL,
    complete   boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, region, tier)
);

CREATE TABLE IF NOT EXISTS player_combat_achievements (
    rsn        text NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    tier       text NOT NULL,
    completed  int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, tier)
);

ALTER TABLE player_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_diaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_combat_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_goals" ON player_goals;
CREATE POLICY "owner_read_goals" ON player_goals
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

-- Public profiles can show the main goal on share cards / OG.
DROP POLICY IF EXISTS "public_read_goals" ON player_goals;
CREATE POLICY "public_read_goals" ON player_goals
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

DROP POLICY IF EXISTS "owner_read_diaries" ON player_diaries;
CREATE POLICY "owner_read_diaries" ON player_diaries
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

DROP POLICY IF EXISTS "public_read_diaries" ON player_diaries;
CREATE POLICY "public_read_diaries" ON player_diaries
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

DROP POLICY IF EXISTS "owner_read_ca" ON player_combat_achievements;
CREATE POLICY "owner_read_ca" ON player_combat_achievements
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

DROP POLICY IF EXISTS "public_read_ca" ON player_combat_achievements;
CREATE POLICY "public_read_ca" ON player_combat_achievements
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

REVOKE INSERT, UPDATE, DELETE ON player_goals FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON player_diaries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON player_combat_achievements FROM anon, authenticated;
GRANT SELECT ON player_goals TO anon, authenticated;
GRANT SELECT ON player_diaries TO anon, authenticated;
GRANT SELECT ON player_combat_achievements TO anon, authenticated;
