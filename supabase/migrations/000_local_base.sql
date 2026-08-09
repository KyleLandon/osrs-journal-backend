-- LOCAL DEVELOPMENT ONLY — reconstructed "personal setup" base schema.
--
-- The published backend repo starts at migration 001_multi_user.sql, which
-- ALTERs / references game-data tables (players, player_skills, player_quests,
-- player_equipment, player_bank) that were created during the project's original
-- single-user "personal setup" era. That original schema was never published in
-- this repo, so a from-scratch `supabase start` has nothing to build on.
--
-- This file recreates just enough of those base tables (columns inferred from the
-- Edge Functions and later migrations) so the full 001..015 migration chain, the
-- Edge Functions, and the RLS model can run against a local Supabase stack. It is
-- intentionally NOT part of the repo's migrations/ directory and MUST NOT be
-- pushed to the production Supabase project (which already has these tables).

-- ── players ──────────────────────────────────────────────────────────────────
-- owner_id (001), quest_points (004) and inventory_tracked (011, later dropped in
-- 012) are added by the real migrations, so they are intentionally omitted here.
CREATE TABLE IF NOT EXISTS players (
    rsn         text        PRIMARY KEY,
    last_synced timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── player_skills ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_skills (
    rsn   text   NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    skill text   NOT NULL,
    level integer,
    xp    bigint,
    PRIMARY KEY (rsn, skill)
);

-- ── player_quests ────────────────────────────────────────────────────────────
-- localhost-read selects (quest_name, state).
CREATE TABLE IF NOT EXISTS player_quests (
    rsn        text NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    quest_name text NOT NULL,
    state      text,
    PRIMARY KEY (rsn, quest_name)
);

-- ── player_equipment ─────────────────────────────────────────────────────────
-- localhost-read selects (slot_id, slot_name, item_id, item_name); sync upserts
-- on conflict (rsn, slot_id).
CREATE TABLE IF NOT EXISTS player_equipment (
    rsn       text    NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    slot_id   integer NOT NULL,
    slot_name text,
    item_id   integer,
    item_name text,
    quantity  integer,
    PRIMARY KEY (rsn, slot_id)
);

-- ── player_bank ──────────────────────────────────────────────────────────────
-- sync upserts / sync_replace_bank RPC insert (rsn, item_id, item_name, quantity)
-- on conflict (rsn, item_id).
CREATE TABLE IF NOT EXISTS player_bank (
    rsn       text    NOT NULL REFERENCES players(rsn) ON DELETE CASCADE,
    item_id   integer NOT NULL,
    item_name text,
    quantity  integer,
    PRIMARY KEY (rsn, item_id)
);

-- Reproduce the legacy Supabase privilege baseline that this backend was written
-- against. Older Supabase projects auto-granted every new table in `public` to the
-- Data API roles (service_role gets full access; anon/authenticated get SELECT),
-- and the repo's migrations then REVOKE the sensitive pieces and rely on RLS to
-- restrict rows. Local stacks default to NOT auto-exposing new tables, so without
-- this the Edge Functions' service-role writes fail ("permission denied for table
-- pair_sessions", etc.). Rather than the deprecated `auto_expose_new_tables`
-- config flag, set matching default privileges so the tables created by the
-- 001..015 migrations inherit the expected grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;

-- Apply the same baseline to the base tables created above (default privileges
-- only affect tables created afterwards).
GRANT ALL ON players, player_skills, player_quests, player_equipment, player_bank
    TO service_role;
GRANT SELECT ON players, player_skills, player_quests, player_equipment, player_bank
    TO anon, authenticated;
