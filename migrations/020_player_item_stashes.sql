-- Extra item storage the plugin can only see when the player opens it:
-- looting bag (Check) and POH costume-room units. Same owner-only privacy as
-- player_inventory. Each container is replaced independently so opening the
-- armour case cannot wipe a previously synced cape rack.

CREATE TABLE IF NOT EXISTS player_item_stashes (
    rsn        text    NOT NULL REFERENCES players (rsn) ON DELETE CASCADE,
    container  text    NOT NULL,
    item_id    integer NOT NULL,
    item_name  text    NOT NULL,
    quantity   integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rsn, container, item_id),
    CONSTRAINT player_item_stashes_container_chk CHECK (
        container IN (
            'looting_bag',
            'poh_magic_wardrobe',
            'poh_armour',
            'poh_fancy_dress',
            'poh_treasure_0',
            'poh_treasure_1',
            'poh_treasure_1a',
            'poh_treasure_2',
            'poh_treasure_2a',
            'poh_treasure_3',
            'poh_treasure_3a',
            'poh_capes',
            'poh_capes_2',
            'poh_holiday'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_player_item_stashes_rsn
    ON player_item_stashes (rsn);

ALTER TABLE player_item_stashes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read_stashes" ON player_item_stashes;
CREATE POLICY "owner_read_stashes" ON player_item_stashes
    FOR SELECT TO authenticated
    USING (rsn IN (SELECT auth_user_rsns()));

REVOKE ALL ON player_item_stashes FROM anon;
GRANT SELECT ON player_item_stashes TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON player_item_stashes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION sync_replace_stash(p_rsn text, p_container text, p_items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_container IS NULL OR p_container NOT IN (
        'looting_bag',
        'poh_magic_wardrobe',
        'poh_armour',
        'poh_fancy_dress',
        'poh_treasure_0',
        'poh_treasure_1',
        'poh_treasure_1a',
        'poh_treasure_2',
        'poh_treasure_2a',
        'poh_treasure_3',
        'poh_treasure_3a',
        'poh_capes',
        'poh_capes_2',
        'poh_holiday'
    ) THEN
        RAISE EXCEPTION 'invalid stash container';
    END IF;

    DELETE FROM player_item_stashes WHERE rsn = p_rsn AND container = p_container;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RETURN;
    END IF;
    INSERT INTO player_item_stashes (rsn, container, item_id, item_name, quantity)
    SELECT
        p_rsn,
        p_container,
        (elem->>'item_id')::integer,
        COALESCE(NULLIF(elem->>'item_name', ''), 'Unknown'),
        GREATEST(COALESCE((elem->>'quantity')::integer, 0), 0)
    FROM jsonb_array_elements(p_items) AS elem
    WHERE elem->>'item_id' IS NOT NULL
    ON CONFLICT (rsn, container, item_id) DO UPDATE
        SET item_name = EXCLUDED.item_name,
            quantity  = EXCLUDED.quantity,
            updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION sync_replace_stash(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_replace_stash(text, text, jsonb) TO service_role;
