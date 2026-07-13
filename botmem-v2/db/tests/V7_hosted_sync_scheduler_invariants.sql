\set ON_ERROR_STOP on
BEGIN;

-- Keep the readiness assertion deterministic when this invariant suite is
-- rerun against a database used by the live integration test.
DELETE FROM botmem.hosted_sync_worker_heartbeat;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '17000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash,
    credential_ref, status, display_label, connection_config
) VALUES (
    '27000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    'gmail', 'oauth2', repeat('7', 64), 'vault:v1:57000000-0000-4000-8000-000000000001',
    'ready', 'Scheduler test', '{}'::jsonb
);
RESET ROLE;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '17000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.hosted_sync_job (
    id, tenant_id, account_id, connector, state,
    request_version, attempts, available_at, requested_at
) VALUES (
    '37000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    '27000000-0000-4000-8000-000000000001',
    'gmail', 'pending', 1, 0,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
RESET ROLE;

SET LOCAL ROLE botmem_worker;
DO $claim_once$
DECLARE
    claimed integer;
BEGIN
    SELECT count(*) INTO claimed
      FROM botmem.claim_hosted_sync_job(
          'worker.test',
          '47000000-0000-4000-8000-000000000001',
          '2026-07-13T10:00:01Z',
          '2026-07-13T10:10:01Z',
          5
      );
    IF claimed <> 1 THEN RAISE EXCEPTION 'worker did not claim one due job'; END IF;
    SELECT count(*) INTO claimed
      FROM botmem.claim_hosted_sync_job(
          'worker.test',
          '47000000-0000-4000-8000-000000000002',
          '2026-07-13T10:00:02Z',
          '2026-07-13T10:10:02Z',
          5
      );
    IF claimed <> 0 THEN RAISE EXCEPTION 'active job was concurrently claimable'; END IF;
    SELECT count(*) INTO claimed
      FROM botmem.claim_hosted_sync_job(
          'worker.recovery',
          '47000000-0000-4000-8000-000000000003',
          '2026-07-13T10:10:02Z',
          '2026-07-13T10:20:02Z',
          5
      );
    IF claimed <> 1 THEN RAISE EXCEPTION 'expired job lease was not crash-reclaimable'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_sync_job
         WHERE id = '37000000-0000-4000-8000-000000000001'
           AND state = 'running' AND attempts = 2
           AND lease_owner = 'worker.recovery'
    ) THEN
        RAISE EXCEPTION 'crash recovery did not advance the attempt and lease owner';
    END IF;
END
$claim_once$;

INSERT INTO botmem.hosted_sync_worker_heartbeat (worker_id, started_at, last_seen_at)
VALUES ('worker.test', '2026-07-13T10:00:00Z', '2026-07-13T10:00:05Z');
RESET ROLE;

SET LOCAL ROLE botmem_api;
DO $readiness$
BEGIN
    IF NOT botmem.hosted_sync_worker_ready('2026-07-13T10:00:10Z', 30) THEN
        RAISE EXCEPTION 'fresh worker heartbeat was not ready';
    END IF;
    IF botmem.hosted_sync_worker_ready('2026-07-13T10:01:00Z', 30) THEN
        RAISE EXCEPTION 'stale worker heartbeat remained ready';
    END IF;
END
$readiness$;

SELECT set_config('botmem.tenant_id', '17000000-0000-4000-8000-000000000002', true);
DO $tenant_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.hosted_sync_job) THEN
        RAISE EXCEPTION 'sync jobs crossed tenant RLS';
    END IF;
END
$tenant_isolation$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $dispatcher_denied$
BEGIN
    BEGIN
        PERFORM * FROM botmem.hosted_sync_job;
        RAISE EXCEPTION 'dispatcher unexpectedly read hosted sync jobs';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$dispatcher_denied$;

ROLLBACK;
