\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '20000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.device_pairing_grant (
    id, tenant_id, workspace_id, code_hash, expires_at, created_at
) VALUES (
    '31000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    decode(repeat('ab', 32), 'hex'),
    '2026-07-13T10:05:00Z', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.device_registry (
    id, tenant_id, workspace_id, display_name, key_id, public_key,
    connectors, status, credential_version, created_at, updated_at
) VALUES (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'Test Mac', 'test-key-1', decode(repeat('01', 32), 'hex'),
    ARRAY['imessage', 'whatsapp'], 'active', 1,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.device_auth_challenge (
    id, tenant_id, workspace_id, device_id, key_id,
    client_nonce_hash, server_nonce_hash, expires_at, created_at
) VALUES (
    '32000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001', 'test-key-1',
    decode(repeat('02', 32), 'hex'), decode(repeat('03', 32), 'hex'),
    '2026-07-13T10:01:00Z', '2026-07-13T10:00:00Z'
);

DO $single_use_and_shape$
DECLARE
    changed integer;
BEGIN
    UPDATE botmem.device_pairing_grant
       SET consumed_at = '2026-07-13T10:00:10Z'
     WHERE id = '31000000-0000-4000-8000-000000000001'
       AND consumed_at IS NULL AND expires_at > '2026-07-13T10:00:10Z';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'pairing grant was not consumed once'; END IF;
    UPDATE botmem.device_pairing_grant
       SET consumed_at = '2026-07-13T10:00:11Z'
     WHERE id = '31000000-0000-4000-8000-000000000001'
       AND consumed_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 0 THEN RAISE EXCEPTION 'pairing grant replay succeeded'; END IF;
    BEGIN
        UPDATE botmem.device_pairing_grant
           SET consumed_at = NULL
         WHERE id = '31000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'pairing grant was reopened';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    UPDATE botmem.device_auth_challenge
       SET consumed_at = '2026-07-13T10:00:10Z'
     WHERE id = '32000000-0000-4000-8000-000000000001'
       AND consumed_at IS NULL AND expires_at > '2026-07-13T10:00:10Z';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'challenge was not consumed once'; END IF;
    UPDATE botmem.device_auth_challenge
       SET consumed_at = '2026-07-13T10:00:11Z'
     WHERE id = '32000000-0000-4000-8000-000000000001'
       AND consumed_at IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 0 THEN RAISE EXCEPTION 'challenge replay succeeded'; END IF;
    BEGIN
        UPDATE botmem.device_auth_challenge
           SET consumed_at = NULL
         WHERE id = '32000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'challenge was reopened';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'botmem'
           AND table_name IN ('device_pairing_grant', 'device_auth_challenge')
           AND column_name IN ('code', 'client_nonce', 'server_nonce', 'signature')
    ) THEN
        RAISE EXCEPTION 'plaintext pairing or challenge secret column exists';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'botmem'
           AND table_name LIKE 'device%'
           AND column_name IN ('payload', 'frame', 'query', 'result', 'message_text')
    ) THEN
        RAISE EXCEPTION 'relay payload persistence column exists';
    END IF;

    BEGIN
        UPDATE botmem.device_registry
           SET public_key = decode(repeat('04', 32), 'hex'),
               updated_at = '2026-07-13T10:00:20Z'
         WHERE id = '30000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'public key changed without key id and version';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
END
$single_use_and_shape$;

UPDATE botmem.device_registry
   SET key_id = 'test-key-2', public_key = decode(repeat('04', 32), 'hex'),
       credential_version = 2, updated_at = '2026-07-13T10:00:20Z'
 WHERE id = '30000000-0000-4000-8000-000000000001';

SELECT set_config('botmem.workspace_id', '20000000-0000-4000-8000-000000000002', true);
DO $workspace_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.device_registry) OR
       EXISTS (SELECT 1 FROM botmem.device_pairing_grant) OR
       EXISTS (SELECT 1 FROM botmem.device_auth_challenge) THEN
        RAISE EXCEPTION 'workspace RLS exposed device security state';
    END IF;
END
$workspace_isolation$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $least_privilege$
BEGIN
    BEGIN
        PERFORM public_key FROM botmem.device_registry;
        RAISE EXCEPTION 'dispatcher unexpectedly read device public identities';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        PERFORM code_hash FROM botmem.device_pairing_grant;
        RAISE EXCEPTION 'dispatcher unexpectedly read pairing hashes';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$least_privilege$;

ROLLBACK;
