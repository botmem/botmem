\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash,
    credential_ref, status, connection_config, aggregate_version, created_at, updated_at
) VALUES
(
    'b1220000-0000-4000-8000-000000000001',
    'b1210000-0000-4000-8000-000000000001',
    'gmail', 'oauth2', repeat('2', 64), 'vault:v12:transient',
    'degraded', '{}'::jsonb, 1, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    'b1220000-0000-4000-8000-000000000002',
    'b1210000-0000-4000-8000-000000000001',
    'outlook', 'oauth2', repeat('3', 64), 'vault:v12:permanent',
    'degraded', '{}'::jsonb, 1, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    'b1220000-0000-4000-8000-000000000003',
    'b1210000-0000-4000-8000-000000000001',
    'owntracks', 'basic', repeat('4', 64), 'vault:v12:cancelled',
    'degraded', '{"endpoint":"https://recorder.example.test/api/0/locations","allowedPorts":[443]}'::jsonb,
    1, '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.hosted_sync_job (
    id, tenant_id, account_id, connector, state, request_version,
    claimed_request_version, attempts, available_at, requested_at,
    started_at, finished_at, lease_owner, lease_token, lease_expires_at,
    failure_code
) VALUES
(
    'b1230000-0000-4000-8000-000000000001',
    'b1210000-0000-4000-8000-000000000001',
    'b1220000-0000-4000-8000-000000000001',
    'gmail', 'retryable_exhausted', 1, 1, 5,
    '2026-07-13T11:00:00Z', '2026-07-13T10:00:00Z',
    '2026-07-13T10:00:00Z', NULL, NULL, NULL, NULL,
    'GMAIL_PROVIDER_UNAVAILABLE'
),
(
    'b1230000-0000-4000-8000-000000000002',
    'b1210000-0000-4000-8000-000000000001',
    'b1220000-0000-4000-8000-000000000002',
    'outlook', 'dead', 1, 1, 1,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', NULL, NULL, NULL,
    'OUTLOOK_AUTH_REVOKED'
),
(
    'b1230000-0000-4000-8000-000000000003',
    'b1210000-0000-4000-8000-000000000001',
    'b1220000-0000-4000-8000-000000000003',
    'owntracks', 'running', 1, 1, 5,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z',
    '2026-07-13T10:00:00Z', NULL, 'v12.crashed-worker',
    'b1250000-0000-4000-8000-000000000001', '2026-07-13T10:30:00Z',
    NULL
);

SET LOCAL ROLE botmem_worker;
SELECT set_config('botmem.tenant_id', 'b1210000-0000-4000-8000-000000000001', true);

DO $bounded_policy$
BEGIN
    BEGIN
        PERFORM * FROM botmem.claim_hosted_sync_job(
            'v12.invalid', 'b1240000-0000-4000-8000-000000000001',
            '2026-07-13T10:00:00Z', '2026-07-13T10:01:00Z', 5, 899
        );
        RAISE EXCEPTION 'claim accepted an exhausted retry cooldown below 15 minutes';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
END
$bounded_policy$;

DO $recovery_policy$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'v12.recovery', 'b1240000-0000-4000-8000-000000000002',
        '2026-07-13T10:59:59Z', '2026-07-13T11:00:59Z', 5, 900
    );
    IF claimed.id IS NOT NULL THEN
        RAISE EXCEPTION 'retryable exhaustion was claimed before its cooldown';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_sync_job
         WHERE id = 'b1230000-0000-4000-8000-000000000003'
           AND state = 'retryable_exhausted'
           AND available_at = '2026-07-13T11:14:59Z'
           AND attempts = 5
           AND failure_code = 'WORKER_LEASE_EXHAUSTED'
    ) THEN
        RAISE EXCEPTION 'crash exhaustion was not scheduled for a fresh probe cooldown';
    END IF;

    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'v12.recovery', 'b1240000-0000-4000-8000-000000000003',
        '2026-07-13T11:00:00Z', '2026-07-13T11:01:00Z', 5, 900
    );
    IF claimed.id <> 'b1230000-0000-4000-8000-000000000001' OR claimed.attempt <> 1 THEN
        RAISE EXCEPTION 'retryable exhaustion did not start a fresh probe cycle';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_sync_job
         WHERE id = 'b1230000-0000-4000-8000-000000000001'
           AND state = 'running' AND attempts = 1 AND failure_code IS NULL
    ) THEN
        RAISE EXCEPTION 'recovery probe did not reset exhausted attempt state';
    END IF;

    UPDATE botmem.hosted_sync_job
       SET state = 'cancelled',
           finished_at = '2026-07-13T11:00:01Z',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = 'INVARIANT_PROBE_COMPLETE'
     WHERE id IN (
         'b1230000-0000-4000-8000-000000000001',
         'b1230000-0000-4000-8000-000000000003'
     );

    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'v12.terminal', 'b1240000-0000-4000-8000-000000000004',
        '2027-07-13T11:00:00Z', '2027-07-13T11:01:00Z', 5, 900
    );
    IF claimed.id IS NOT NULL THEN
        RAISE EXCEPTION 'dead or cancelled job recovered without explicit enqueue';
    END IF;

END
$recovery_policy$;

ROLLBACK;
