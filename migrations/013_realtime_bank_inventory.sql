-- Live refresh for bank / inventory (owner-only via RLS; never public).
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_bank;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_inventory;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
