-- Cut Realtime WAL from high-churn item tables, and collapse rate-limit +
-- last_synced into single SQL calls so /sync is not 2–3 extra round trips.

-- ── Realtime: keep players / skills / quests; drop bank + inventory ──────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'player_bank'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE player_bank;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'player_inventory'
    ) THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE player_inventory;
    END IF;
END $$;

-- ── Rate limit: count + insert (+ rare cleanup) in one round trip ────────────
CREATE OR REPLACE FUNCTION check_rate_limit(
    p_bucket text,
    p_max_events integer,
    p_window_ms integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    n integer;
    win interval;
BEGIN
    IF p_bucket IS NULL OR p_bucket = '' OR p_max_events IS NULL OR p_window_ms IS NULL THEN
        RETURN true;
    END IF;
    win := make_interval(secs => GREATEST(p_window_ms, 1) / 1000.0);
    SELECT count(*)::int INTO n
    FROM rate_limit_events
    WHERE bucket = p_bucket
      AND created_at >= clock_timestamp() - win;
    IF n >= p_max_events THEN
        RETURN false;
    END IF;
    INSERT INTO rate_limit_events (bucket) VALUES (p_bucket);
    IF random() < 0.02 THEN
        DELETE FROM rate_limit_events
        WHERE created_at < clock_timestamp() - (win * 4);
    END IF;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_rate_limit(text, integer, integer) TO service_role;

-- ── last_synced: no-op unless the previous ping is older than the interval ───
CREATE OR REPLACE FUNCTION touch_player_last_synced(
    p_rsn text,
    p_min_interval_seconds integer DEFAULT 60
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_rsn IS NULL OR p_rsn = '' THEN
        RETURN;
    END IF;
    INSERT INTO players (rsn, last_synced)
    VALUES (p_rsn, clock_timestamp())
    ON CONFLICT (rsn) DO UPDATE
        SET last_synced = EXCLUDED.last_synced
        WHERE players.last_synced IS NULL
           OR players.last_synced < clock_timestamp()
              - make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 60), 1));
END;
$$;

REVOKE ALL ON FUNCTION touch_player_last_synced(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_player_last_synced(text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
