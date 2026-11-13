-- Live refresh for worn equipment (owner-only via RLS; never public).
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_equipment;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
