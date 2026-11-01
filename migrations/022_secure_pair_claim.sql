-- Only the owning website account can replace a linked character credential.
-- Serialize claims by case-insensitive RSN so concurrent first claims cannot
-- create differently cased links or transfer ownership. All writes roll back
-- together if the code, character, or player update fails.
CREATE OR REPLACE FUNCTION claim_pair_session(p_code text, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    pending pair_sessions%ROWTYPE;
    existing user_characters%ROWTYPE;
    canonical_rsn text;
BEGIN
    SELECT * INTO pending FROM pair_sessions
    WHERE code = p_code AND claimed_by IS NULL AND expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or expired pairing code';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(lower(pending.rsn), 0));
    SELECT * INTO existing FROM user_characters
    WHERE lower(rsn) = lower(pending.rsn)
    FOR UPDATE;
    IF FOUND THEN
        IF existing.user_id <> p_user_id THEN
            RAISE EXCEPTION 'Character already linked to another account';
        END IF;
        canonical_rsn := existing.rsn;
        UPDATE user_characters
        SET sync_token = pending.sync_token, updated_at = now()
        WHERE id = existing.id;
        -- Existing browser sessions should not outlive credential replacement.
        DELETE FROM localhost_sessions WHERE rsn = canonical_rsn;
    ELSE
        canonical_rsn := pending.rsn;
        INSERT INTO user_characters(user_id, rsn, sync_token, is_public)
        VALUES (p_user_id, canonical_rsn, pending.sync_token, true);
    END IF;

    INSERT INTO players(rsn, owner_id) VALUES (canonical_rsn, p_user_id)
    ON CONFLICT (rsn) DO UPDATE SET owner_id = EXCLUDED.owner_id;
    UPDATE pair_sessions SET claimed_by = p_user_id, claimed_at = now()
    WHERE code = pending.code;
    RETURN canonical_rsn;
END;
$$;

REVOKE ALL ON FUNCTION claim_pair_session(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_pair_session(text, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
