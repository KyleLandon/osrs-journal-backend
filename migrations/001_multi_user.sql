-- OSRS Journal — multi-user schema
-- Run in Supabase SQL editor or via supabase db push
--
-- Prerequisites: Supabase Auth enabled (email or OAuth providers)
--
-- After migration:
--   1. Revoke open anon write policies from the personal setup
--   2. Route plugin writes through Edge Functions (service role)
--   3. Web reads use authenticated role + RLS below

-- ── Character ownership ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_characters (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    rsn         text        NOT NULL,
    sync_token  uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    is_public   boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, rsn),
    UNIQUE (rsn)
);

CREATE INDEX IF NOT EXISTS idx_user_characters_user_id ON user_characters(user_id);
CREATE INDEX IF NOT EXISTS idx_user_characters_sync_token ON user_characters(sync_token);

-- ── Pairing sessions (plugin → website link) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS pair_sessions (
    code        text        PRIMARY KEY,
    rsn         text        NOT NULL,
    sync_token  uuid        NOT NULL,
    expires_at  timestamptz NOT NULL,
    claimed_by  uuid        REFERENCES auth.users(id),
    claimed_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pair_sessions_expires ON pair_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pair_sessions_unclaimed
    ON pair_sessions(expires_at) WHERE claimed_by IS NULL;

-- ── Extend players table ──────────────────────────────────────────────────────

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE user_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE pair_sessions    ENABLE ROW LEVEL SECURITY;

-- Users manage their own character links
CREATE POLICY "users_read_own_characters" ON user_characters
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "users_update_own_characters" ON user_characters
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "users_delete_own_characters" ON user_characters
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- Public profile flag (skills/quests visibility only — enforced per-table below)
CREATE POLICY "public_character_list" ON user_characters
    FOR SELECT TO anon, authenticated
    USING (is_public = true);

-- Pair sessions: users can read codes they are claiming (via Edge Function, not direct)
-- Direct client access to pair_sessions should be denied; only service role writes.
CREATE POLICY "deny_direct_pair_access" ON pair_sessions
    FOR ALL TO anon, authenticated
    USING (false);

-- ── Game data tables: authenticated owner access ─────────────────────────────

ALTER TABLE players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_skills    ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_quests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_bank      ENABLE ROW LEVEL SECURITY;

-- Drop open policies from personal setup if they exist
DROP POLICY IF EXISTS "anon_read_players"     ON players;
DROP POLICY IF EXISTS "anon_read_skills"      ON player_skills;
DROP POLICY IF EXISTS "anon_read_quests"      ON player_quests;
DROP POLICY IF EXISTS "anon_read_equipment"   ON player_equipment;
DROP POLICY IF EXISTS "anon_read_bank"        ON player_bank;
DROP POLICY IF EXISTS "anon_write_players"    ON players;
DROP POLICY IF EXISTS "anon_write_skills"     ON player_skills;
DROP POLICY IF EXISTS "anon_write_quests"     ON player_quests;
DROP POLICY IF EXISTS "anon_write_equipment"  ON player_equipment;
DROP POLICY IF EXISTS "anon_write_bank"       ON player_bank;

-- Helper: RSNs owned by the current user
CREATE OR REPLACE FUNCTION auth_user_rsns()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rsn FROM user_characters WHERE user_id = auth.uid();
$$;

-- Helper: RSNs with public profiles
CREATE OR REPLACE FUNCTION public_rsns()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rsn FROM user_characters WHERE is_public = true;
$$;

-- Owner read access
CREATE POLICY "owner_read_players" ON players
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

CREATE POLICY "owner_read_skills" ON player_skills
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

CREATE POLICY "owner_read_quests" ON player_quests
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

CREATE POLICY "owner_read_equipment" ON player_equipment
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

CREATE POLICY "owner_read_bank" ON player_bank
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

-- Public read (skills + quests + player row only — NOT bank or equipment)
CREATE POLICY "public_read_players" ON players
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

CREATE POLICY "public_read_skills" ON player_skills
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

CREATE POLICY "public_read_quests" ON player_quests
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

-- No anon/authenticated direct writes on game data — plugin uses Edge Functions + service role

-- ── Cleanup job (run via pg_cron or scheduled Edge Function) ──────────────────

-- DELETE FROM pair_sessions WHERE expires_at < now();
