-- Column-level privileges: RLS controls which ROWS are visible, but the
-- default Supabase grants expose ALL columns on visible rows. The
-- "public_character_list" policy made sync_token (the plugin's write
-- credential) readable by anon for every public character. Restrict client
-- roles to a safe column whitelist; Edge Functions use the service role and
-- are unaffected.

-- user_characters: never expose sync_token or user_id to client roles
REVOKE SELECT ON user_characters FROM anon, authenticated;
GRANT SELECT (id, rsn, is_public, created_at, updated_at)
    ON user_characters TO anon, authenticated;

-- players: owner_id (auth user UUID) allows correlating characters to one
-- account — hide it from client roles
REVOKE SELECT ON players FROM anon, authenticated;
GRANT SELECT (rsn, last_synced, created_at, quest_points)
    ON players TO anon, authenticated;
