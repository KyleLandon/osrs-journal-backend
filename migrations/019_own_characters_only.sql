-- public_character_list let every signed-in user SELECT all public RSNs.
-- The site treated that list as "my linked characters", so new accounts
-- opened KyleLandon and thought they owned other public profiles (inventory
-- then failed RLS and looked empty). Public skills/quests still use public_rsns().

DROP POLICY IF EXISTS "public_character_list" ON user_characters;

CREATE OR REPLACE FUNCTION linked_characters()
RETURNS TABLE (rsn text, is_public boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT uc.rsn, uc.is_public
    FROM user_characters uc
    WHERE uc.user_id = auth.uid()
    ORDER BY uc.created_at ASC;
$$;

REVOKE ALL ON FUNCTION linked_characters() FROM PUBLIC;
REVOKE ALL ON FUNCTION linked_characters() FROM anon;
GRANT EXECUTE ON FUNCTION linked_characters() TO authenticated;

NOTIFY pgrst, 'reload schema';
