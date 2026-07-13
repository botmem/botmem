\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash,
    credential_ref, status, aggregate_version, created_at, updated_at
) VALUES (
    'b1100000-0000-4000-8000-000000000001',
    'b1110000-0000-4000-8000-000000000001',
    'gmail', 'oauth2', repeat('1', 64), 'vault:periodic-invariant',
    'ready', 1, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.hosted_sync_job (
    id, tenant_id, account_id, connector, state, request_version,
    claimed_request_version, attempts, available_at, requested_at,
    finished_at
) VALUES (
    'b1120000-0000-4000-8000-000000000001',
    'b1110000-0000-4000-8000-000000000001',
    'b1100000-0000-4000-8000-000000000001',
    'gmail', 'completed', 1, 1, 19,
    '2026-07-13T10:05:00Z', '2026-07-13T10:00:00Z',
    '2026-07-13T10:00:00Z'
);

SET LOCAL ROLE botmem_worker;
DO $periodic_claim$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'periodic-invariant', 'b1130000-0000-4000-8000-000000000001',
        '2026-07-13T10:04:59Z', '2026-07-13T10:05:59Z', 5
    );
    IF claimed.id IS NOT NULL THEN
        RAISE EXCEPTION 'completed job was claimed before its durable due time';
    END IF;

    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'periodic-invariant', 'b1130000-0000-4000-8000-000000000002',
        '2026-07-13T10:05:00Z', '2026-07-13T10:06:00Z', 5
    );
    IF claimed.id <> 'b1120000-0000-4000-8000-000000000001' OR claimed.attempt <> 1 THEN
        RAISE EXCEPTION 'due completed job was not claimed as a fresh sync cycle';
    END IF;

    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'periodic-invariant-2', 'b1130000-0000-4000-8000-000000000003',
        '2026-07-13T10:05:01Z', '2026-07-13T10:06:01Z', 5
    );
    IF claimed.id IS NOT NULL THEN
        RAISE EXCEPTION 'active periodic job received a duplicate lease';
    END IF;
END
$periodic_claim$;

ROLLBACK;
