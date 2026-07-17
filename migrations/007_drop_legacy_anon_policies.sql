-- The personal-setup era created a permissive "anon_all" (FOR ALL USING true)
-- policy on every game-data table. 001_multi_user.sql only dropped policies
-- named anon_read_*/anon_write_*, so anon_all survived — leaving anonymous
-- users full read AND write access to all game data, including private banks.

DROP POLICY IF EXISTS "anon_all" ON players;
DROP POLICY IF EXISTS "anon_all" ON player_skills;
DROP POLICY IF EXISTS "anon_all" ON player_quests;
DROP POLICY IF EXISTS "anon_all" ON player_equipment;
DROP POLICY IF EXISTS "anon_all" ON player_bank;

-- Belt and braces: client roles never write game data directly (Edge Functions
-- use the service role), so revoke write privileges outright.
REVOKE INSERT, UPDATE, DELETE ON players, player_skills, player_quests,
    player_equipment, player_bank FROM anon, authenticated;

-- Remove the row inserted while verifying this vulnerability
DELETE FROM players WHERE rsn = 'AnonWriteTest';
