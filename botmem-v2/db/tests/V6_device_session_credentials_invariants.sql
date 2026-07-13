\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '66000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '66000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.device_registry (
    id, tenant_id, workspace_id, display_name, key_id, public_key,
    connectors, status, credential_version, created_at, updated_at
) VALUES (
    '66000000-0000-4000-8000-000000000002',
    '66000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000001',
    'V6 Mac', 'v6-key', decode(repeat('66', 32), 'hex'),
    ARRAY['imessage'], 'active', 1,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.device_session_credential (
    id, tenant_id, workspace_id, device_id, credential_version,
    created_at, expires_at
) VALUES (
    '66000000-0000-4000-8000-000000000003',
    '66000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002', 1,
    '2026-07-13T10:00:01Z', '2026-07-13T10:15:01Z'
);

DO $credential_invariants$
BEGIN
    BEGIN
        INSERT INTO botmem.device_session_credential (
            id, tenant_id, workspace_id, device_id, credential_version,
            created_at, expires_at
        ) VALUES (
            '66000000-0000-4000-8000-000000000004',
            '66000000-0000-4000-8000-000000000001',
            '66000000-0000-4000-8000-000000000001',
            '66000000-0000-4000-8000-000000000002', 1,
            '2026-07-13T10:00:02Z', '2026-07-13T10:15:02Z'
        );
        RAISE EXCEPTION 'two active device credentials were allowed';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'botmem'
           AND table_name = 'device_session_credential'
           AND column_name IN ('payload', 'frame', 'query', 'result', 'cursor', 'corpus', 'secret')
    ) THEN
        RAISE EXCEPTION 'device session credential persists forbidden content';
    END IF;
END
$credential_invariants$;

UPDATE botmem.device_session_credential
   SET revoked_at = '2026-07-13T10:01:00Z', revocation_reason = 'replaced'
 WHERE id = '66000000-0000-4000-8000-000000000003';

INSERT INTO botmem.device_session_credential (
    id, tenant_id, workspace_id, device_id, credential_version,
    created_at, expires_at
) VALUES (
    '66000000-0000-4000-8000-000000000004',
    '66000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002', 1,
    '2026-07-13T10:01:01Z', '2026-07-13T10:16:01Z'
);

DO $immutability$
BEGIN
    BEGIN
        UPDATE botmem.device_session_credential
           SET expires_at = '2026-07-13T10:20:00Z'
         WHERE id = '66000000-0000-4000-8000-000000000004';
        RAISE EXCEPTION 'credential expiry was mutated';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE '55000' THEN
        NULL;
    END;
    IF NOT (
        SELECT newer.generation > older.generation
          FROM botmem.device_session_credential older
          JOIN botmem.device_session_credential newer ON newer.device_id = older.device_id
         WHERE older.id = '66000000-0000-4000-8000-000000000003'
           AND newer.id = '66000000-0000-4000-8000-000000000004'
    ) THEN
        RAISE EXCEPTION 'device session generation did not increase';
    END IF;
END
$immutability$;

SELECT set_config('botmem.workspace_id', '66000000-0000-4000-8000-000000000099', true);
DO $rls$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.device_session_credential) THEN
        RAISE EXCEPTION 'workspace RLS exposed device session credentials';
    END IF;
END
$rls$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $least_privilege$
BEGIN
    BEGIN
        PERFORM id FROM botmem.device_session_credential;
        RAISE EXCEPTION 'dispatcher read device session credentials';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$least_privilege$;

ROLLBACK;
