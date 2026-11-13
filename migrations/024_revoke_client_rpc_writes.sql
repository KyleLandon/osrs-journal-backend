-- The write RPCs are SECURITY DEFINER and trust their p_rsn argument, so only
-- the Edge Functions (service_role, after sync-token checks) may call them.
-- Earlier migrations revoked PUBLIC, but Supabase's default privileges also
-- grant EXECUTE to anon/authenticated directly, which left every one of these
-- callable via /rest/v1/rpc with the public anon key.
REVOKE EXECUTE ON FUNCTION sync_replace_bank(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_replace_inventory(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_replace_stash(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_replace_collection_log(text, text, jsonb, int, int, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_upsert_skills(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION touch_player_last_synced(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION sync_replace_bank(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION sync_replace_inventory(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION sync_replace_stash(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION sync_replace_collection_log(text, text, jsonb, int, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION sync_upsert_skills(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION touch_player_last_synced(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit(text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
