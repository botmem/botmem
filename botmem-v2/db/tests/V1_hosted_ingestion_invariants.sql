\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash, credential_ref, status
) VALUES (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'gmail',
    'oauth2',
    repeat('1', 64),
    'secret://test/account',
    'ready'
);

DO $test$
BEGIN
    BEGIN
        INSERT INTO botmem.connector_account (
            id, tenant_id, connector, auth_kind, provider_subject_hash, credential_ref, status
        ) VALUES (
            '20000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            'gmail',
            'oauth2',
            repeat('1', 64),
            'secret://test/duplicate-account',
            'ready'
        );
        RAISE EXCEPTION 'duplicate provider subject unexpectedly succeeded';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$test$;

RESET ROLE;
SET LOCAL ROLE botmem_worker;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.connector_checkpoint (tenant_id, account_id)
VALUES (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
);

INSERT INTO botmem.connector_sync (
    id, tenant_id, account_id, aggregate_version_at_claim, started_at, lease_expires_at
) VALUES (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    0,
    '2026-07-13T10:00:00Z',
    '2026-07-13T10:15:00Z'
);

DO $test$
BEGIN
    BEGIN
        INSERT INTO botmem.connector_sync (
            id, tenant_id, account_id, aggregate_version_at_claim, started_at, lease_expires_at
        ) VALUES (
            '30000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            0,
            '2026-07-13T10:01:00Z',
            '2026-07-13T10:16:00Z'
        );
        RAISE EXCEPTION 'second active sync unexpectedly succeeded';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$test$;

INSERT INTO botmem.ingest_event_revision (
    id, tenant_id, account_id, source_event_id, source_revision, kind,
    occurred_at, observed_at, content_hash, payload
) VALUES (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'provider-message-1',
    'revision-1',
    'email',
    '2026-07-13T09:00:00Z',
    '2026-07-13T10:00:00Z',
    repeat('a', 64),
    '{"subject":"original"}'::jsonb
);

INSERT INTO botmem.ingest_event_head (
    tenant_id, account_id, source_event_id, head_revision_id, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'provider-message-1',
    '40000000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.transactional_outbox (
    id, tenant_id, account_id, revision_id, payload
) VALUES (
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '{"revisionId":"40000000-0000-4000-8000-000000000001"}'::jsonb
);

UPDATE botmem.connector_checkpoint
   SET cursor_version = 1,
       cursor = '{"page":1}'::jsonb,
       last_sync_id = '30000000-0000-4000-8000-000000000001',
       last_committed_at = '2026-07-13T10:00:00Z'
 WHERE account_id = '20000000-0000-4000-8000-000000000001';

UPDATE botmem.connector_account
   SET aggregate_version = aggregate_version + 1,
       updated_at = statement_timestamp()
 WHERE id = '20000000-0000-4000-8000-000000000001';

DO $test$
BEGIN
    BEGIN
        UPDATE botmem.ingest_event_revision
           SET payload = '{"subject":"mutated"}'::jsonb
         WHERE id = '40000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'immutable revision unexpectedly updated';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE '55000' THEN
        NULL;
    END;
END
$test$;

SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000002', true);
DO $test$
BEGIN
    IF (SELECT count(*) FROM botmem.connector_account) <> 0 THEN
        RAISE EXCEPTION 'tenant RLS exposed another tenant account';
    END IF;
END
$test$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;

DO $test$
BEGIN
    IF (SELECT count(id) FROM botmem.transactional_outbox) <> 1 THEN
        RAISE EXCEPTION 'dispatcher could not read outbox routing metadata';
    END IF;
    BEGIN
        PERFORM payload FROM botmem.transactional_outbox;
        RAISE EXCEPTION 'dispatcher unexpectedly read outbox payload';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$test$;

ROLLBACK;
