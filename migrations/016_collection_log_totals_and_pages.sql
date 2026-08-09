-- Collection log totals on the player row (VarPlayer COLLECTION_COUNT /
-- COLLECTION_COUNT_MAX) plus per-page metadata (obtained X/Y and kill counts)
-- captured when a Collection Log page is opened in RuneLite.

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS collection_count int,
    ADD COLUMN IF NOT EXISTS collection_count_max int;

-- Column privileges: extend the public-safe whitelist (was set in 006).
REVOKE SELECT ON players FROM anon, authenticated;
GRANT SELECT (rsn, last_synced, created_at, quest_points, collection_count, collection_count_max)
    ON players TO anon, authenticated;

CREATE TABLE IF NOT EXISTS player_collection_pages (
    rsn            text        NOT NULL REFERENCES players (rsn) ON DELETE CASCADE,
    page           text        NOT NULL,
    obtained       int,
    obtained_total int,
    kill_counts    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, page)
);

CREATE INDEX IF NOT EXISTS idx_player_collection_pages_rsn
    ON player_collection_pages (rsn);

ALTER TABLE player_collection_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_collection_pages" ON player_collection_pages;
CREATE POLICY "owner_read_collection_pages" ON player_collection_pages
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

DROP POLICY IF EXISTS "public_read_collection_pages" ON player_collection_pages;
CREATE POLICY "public_read_collection_pages" ON player_collection_pages
    FOR SELECT TO anon, authenticated
    USING (rsn IN (SELECT public_rsns()));

REVOKE INSERT, UPDATE, DELETE ON player_collection_pages FROM anon, authenticated;
GRANT SELECT ON player_collection_pages TO anon, authenticated;

-- Replace the page items AND upsert page metadata in one call.
-- Drop the 3-arg form from 015 so PostgREST has a single unambiguous RPC.
DROP FUNCTION IF EXISTS sync_replace_collection_log(text, text, jsonb);

CREATE OR REPLACE FUNCTION sync_replace_collection_log(
    p_rsn text,
    p_page text,
    p_items jsonb,
    p_obtained int DEFAULT NULL,
    p_obtained_total int DEFAULT NULL,
    p_kill_counts jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM player_collection_log WHERE rsn = p_rsn AND page = p_page;
    IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
        INSERT INTO player_collection_log (rsn, page, item_id, item_name, quantity)
        SELECT
            p_rsn,
            p_page,
            (e->>'item_id')::int,
            COALESCE(e->>'item_name', ''),
            COALESCE((e->>'quantity')::int, 1)
        FROM jsonb_array_elements(p_items) e
        WHERE e->>'item_id' IS NOT NULL;
    END IF;

    INSERT INTO player_collection_pages (rsn, page, obtained, obtained_total, kill_counts, updated_at)
    VALUES (
        p_rsn,
        p_page,
        p_obtained,
        p_obtained_total,
        CASE
            WHEN p_kill_counts IS NULL OR jsonb_typeof(p_kill_counts) <> 'array' THEN '[]'::jsonb
            ELSE p_kill_counts
        END,
        now()
    )
    ON CONFLICT (rsn, page) DO UPDATE SET
        obtained = COALESCE(EXCLUDED.obtained, player_collection_pages.obtained),
        obtained_total = COALESCE(EXCLUDED.obtained_total, player_collection_pages.obtained_total),
        kill_counts = EXCLUDED.kill_counts,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION sync_replace_collection_log(text, text, jsonb, int, int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_replace_collection_log(text, text, jsonb, int, int, jsonb) TO service_role;
