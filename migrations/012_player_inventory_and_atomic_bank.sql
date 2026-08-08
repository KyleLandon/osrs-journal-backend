-- Move inventory off the public-readable players row into an owner-only table
-- (same privacy model as player_bank). Also add transactional replace helpers
-- so delete+insert cannot leave an empty bank/inventory mid-failure.

CREATE TABLE IF NOT EXISTS player_inventory (
    rsn       text    NOT NULL REFERENCES players (rsn) ON DELETE CASCADE,
    item_id   integer NOT NULL,
    item_name text    NOT NULL,
    quantity  integer NOT NULL DEFAULT 0,
    PRIMARY KEY (rsn, item_id)
);

ALTER TABLE player_inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_inventory" ON player_inventory;
CREATE POLICY "owner_read_inventory" ON player_inventory
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

-- No public / anon inventory reads. Service role (Edge Functions) bypasses RLS.
REVOKE ALL ON player_inventory FROM anon;
GRANT SELECT ON player_inventory TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON player_inventory FROM anon, authenticated;

-- Migrate any legacy JSON snapshots from players.inventory_tracked.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'players'
          AND column_name = 'inventory_tracked'
    ) THEN
        INSERT INTO player_inventory (rsn, item_id, item_name, quantity)
        SELECT
            p.rsn,
            (item->>'item_id')::integer,
            COALESCE(NULLIF(item->>'item_name', ''), 'Unknown'),
            GREATEST(COALESCE((item->>'quantity')::integer, 0), 0)
        FROM players p
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(COALESCE(p.inventory_tracked, '[]'::jsonb)) = 'array'
                    THEN COALESCE(p.inventory_tracked, '[]'::jsonb)
                ELSE '[]'::jsonb
            END
        ) AS item
        WHERE item->>'item_id' IS NOT NULL
        ON CONFLICT (rsn, item_id) DO UPDATE
            SET item_name = EXCLUDED.item_name,
                quantity  = EXCLUDED.quantity;

        ALTER TABLE players DROP COLUMN inventory_tracked;
    END IF;
END $$;

-- Atomic bank replace (service role only).
CREATE OR REPLACE FUNCTION sync_replace_bank(p_rsn text, p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM player_bank WHERE rsn = p_rsn;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RETURN;
    END IF;
    INSERT INTO player_bank (rsn, item_id, item_name, quantity)
    SELECT
        p_rsn,
        (elem->>'item_id')::integer,
        COALESCE(NULLIF(elem->>'item_name', ''), 'Unknown'),
        GREATEST(COALESCE((elem->>'quantity')::integer, 0), 0)
    FROM jsonb_array_elements(p_items) AS elem
    WHERE elem->>'item_id' IS NOT NULL
    ON CONFLICT (rsn, item_id) DO UPDATE
        SET item_name = EXCLUDED.item_name,
            quantity  = EXCLUDED.quantity;
END;
$$;

-- Atomic inventory replace (service role only).
CREATE OR REPLACE FUNCTION sync_replace_inventory(p_rsn text, p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM player_inventory WHERE rsn = p_rsn;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RETURN;
    END IF;
    INSERT INTO player_inventory (rsn, item_id, item_name, quantity)
    SELECT
        p_rsn,
        (elem->>'item_id')::integer,
        COALESCE(NULLIF(elem->>'item_name', ''), 'Unknown'),
        GREATEST(COALESCE((elem->>'quantity')::integer, 0), 0)
    FROM jsonb_array_elements(p_items) AS elem
    WHERE elem->>'item_id' IS NOT NULL
    ON CONFLICT (rsn, item_id) DO UPDATE
        SET item_name = EXCLUDED.item_name,
            quantity  = EXCLUDED.quantity;
END;
$$;

REVOKE ALL ON FUNCTION sync_replace_bank(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_replace_inventory(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_replace_bank(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION sync_replace_inventory(text, jsonb) TO service_role;
