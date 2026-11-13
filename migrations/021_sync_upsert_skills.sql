-- Skip no-op skill writes so training one skill does not UPDATE all 24 rows
-- (and fan 24 Realtime WAL events). Unchanged level/xp is a true no-op.

CREATE OR REPLACE FUNCTION sync_upsert_skills(p_rsn text, p_skills jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_rsn IS NULL OR p_rsn = ''
       OR p_skills IS NULL
       OR jsonb_typeof(p_skills) <> 'array'
       OR jsonb_array_length(p_skills) = 0
    THEN
        RETURN;
    END IF;

    INSERT INTO player_skills (rsn, skill, level, xp)
    SELECT
        p_rsn,
        elem->>'skill',
        GREATEST(COALESCE((elem->>'level')::integer, 1), 1),
        GREATEST(COALESCE((elem->>'xp')::bigint, 0), 0)
    FROM jsonb_array_elements(p_skills) AS elem
    WHERE NULLIF(elem->>'skill', '') IS NOT NULL
    ON CONFLICT (rsn, skill) DO UPDATE
        SET level = EXCLUDED.level,
            xp    = EXCLUDED.xp
        WHERE player_skills.level IS DISTINCT FROM EXCLUDED.level
           OR player_skills.xp    IS DISTINCT FROM EXCLUDED.xp;
END;
$$;

REVOKE ALL ON FUNCTION sync_upsert_skills(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_upsert_skills(text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
