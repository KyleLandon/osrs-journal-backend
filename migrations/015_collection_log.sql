-- Collection Log pages captured by the RuneLite plugin when the player opens
-- a log page. Written only via /sync (service role RPC); clients are read-only.

CREATE TABLE IF NOT EXISTS player_collection_log (
    rsn        text        NOT NULL REFERENCES players (rsn) ON DELETE CASCADE,
    page       text        NOT NULL,
    item_id    int         NOT NULL,
    item_name  text        NOT NULL DEFAULT '',
    quantity   int         NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, page, item_id)
);

CREATE INDEX IF NOT EXISTS idx_player_collection_log_rsn
    ON player_collection_log (rsn);

ALTER TABLE player_collection_log ENABLE ROW LEVEL SECURITY;

-- Same visibility as player_skills: owner always, public profiles for everyone.
DROP POLICY IF EXISTS "owner_read_collection_log" ON player_collection_log;
CREATE POLICY "owner_read_collection_log" ON player_collection_log
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

DROP POLICY IF EXISTS "public_read_collection_log" ON player_collection_log;
CREATE POLICY "public_read_collection_log" ON player_collection_log
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

REVOKE INSERT, UPDATE, DELETE ON player_collection_log FROM anon, authenticated;
GRANT SELECT ON player_collection_log TO anon, authenticated;

-- Atomic page replace (service role only). Deletes the page then inserts the
-- obtained items so a partial failure cannot leave a half-updated page.
CREATE OR REPLACE FUNCTION sync_replace_collection_log(p_rsn text, p_page text, p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM player_collection_log WHERE rsn = p_rsn AND page = p_page;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RETURN;
    END IF;
    INSERT INTO player_collection_log (rsn, page, item_id, item_name, quantity)
    SELECT
        p_rsn,
        p_page,
        (e->>'item_id')::int,
        COALESCE(e->>'item_name', ''),
        COALESCE((e->>'quantity')::int, 1)
    FROM jsonb_array_elements(p_items) e
    WHERE e->>'item_id' IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION sync_replace_collection_log(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_replace_collection_log(text, text, jsonb) TO service_role;
