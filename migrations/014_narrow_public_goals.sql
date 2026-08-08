-- Narrow public access to goals: anonymous readers previously got the full
-- planner JSON for any public character via the "public_read_goals" policy.
-- The only anonymous consumer (the Cloudflare Worker's OG share cards) needs
-- just the main goal's label, so expose exactly that through an RPC and drop
-- the broad policy.

DROP POLICY IF EXISTS "public_read_goals" ON player_goals;

-- Owners still read their own goals via "owner_read_goals" (authenticated);
-- anon no longer needs any direct table access.
REVOKE SELECT ON player_goals FROM anon;

-- Returns the label of the public character's main goal, or NULL when the
-- character is private, has no goals, or has no main goal set.
CREATE OR REPLACE FUNCTION public_main_goal(p_rsn text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(g.elem->>'label', g.elem->>'quest')
    FROM player_goals pg,
         LATERAL jsonb_array_elements(pg.goals) AS g(elem)
    WHERE pg.rsn = p_rsn
      AND pg.rsn IN (SELECT public_rsns())
      AND g.elem->'main' = 'true'::jsonb
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public_main_goal(text) TO anon, authenticated;
