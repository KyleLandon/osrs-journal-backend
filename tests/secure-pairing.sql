-- Run with psql against an isolated Supabase database after all migrations:
-- psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/secure-pairing.sql
-- Fixtures and mutations are rolled back. Never use production for this test.
BEGIN;
DO $$
DECLARE
    owner_id uuid := gen_random_uuid();
    other_id uuid := gen_random_uuid();
    old_token uuid := gen_random_uuid();
    pending_token uuid := gen_random_uuid();
    character_name text := 'QA' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    pair_code text := gen_random_uuid()::text;
    actual_rsn text;
BEGIN
    INSERT INTO auth.users(id, email)
    VALUES (owner_id, owner_id::text || '@example.invalid'),
           (other_id, other_id::text || '@example.invalid');
    INSERT INTO players(rsn, owner_id) VALUES (character_name, owner_id);
    INSERT INTO user_characters(user_id, rsn, sync_token)
    VALUES (owner_id, character_name, old_token);
    INSERT INTO localhost_sessions(token, rsn, expires_at)
    VALUES (gen_random_uuid(), character_name, now() + interval '5 minutes');
    INSERT INTO pair_sessions(code, rsn, sync_token, expires_at)
    VALUES (pair_code, lower(character_name), pending_token, now() + interval '10 minutes');

    BEGIN
        PERFORM claim_pair_session(pair_code, other_id);
        RAISE EXCEPTION 'TEST FAILED: non-owner claimed existing character';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'Character already linked to another account' THEN RAISE; END IF;
    END;
    IF NOT EXISTS (SELECT 1 FROM user_characters WHERE rsn = character_name AND sync_token = old_token)
       OR NOT EXISTS (SELECT 1 FROM pair_sessions WHERE code = pair_code AND claimed_by IS NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: rejected claim changed credentials/code';
    END IF;

    actual_rsn := claim_pair_session(pair_code, owner_id);
    IF actual_rsn <> character_name THEN RAISE EXCEPTION 'TEST FAILED: canonical name lost'; END IF;
    IF NOT EXISTS (SELECT 1 FROM user_characters WHERE rsn = character_name AND sync_token = pending_token AND user_id = owner_id)
       OR EXISTS (SELECT 1 FROM localhost_sessions WHERE rsn = character_name) THEN
        RAISE EXCEPTION 'TEST FAILED: owner rotation/session invalidation failed';
    END IF;
    BEGIN
        PERFORM claim_pair_session(pair_code, owner_id);
        RAISE EXCEPTION 'TEST FAILED: pairing code reused';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'Invalid or expired pairing code' THEN RAISE; END IF;
    END;

    IF has_function_privilege('anon', 'claim_pair_session(text,uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'claim_pair_session(text,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'TEST FAILED: client role can call privileged claim RPC';
    END IF;
    RAISE NOTICE 'Owner-only rotation, canonical names, rollback, code reuse, and grants passed';
END;
$$;
ROLLBACK;
