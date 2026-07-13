\set ON_ERROR_STOP on

-- Run only against a database migrated through V14. This regression seeds
-- final-attempt active work before applying V15, proving the migration replays
-- the interrupted attempt instead of stranding a nonterminal row.
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.workspace (
    id, tenant_id, display_name, status, created_at, updated_at
) VALUES (
    'a1500000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'V15 upgrade fixture', 'deleting', clock_timestamp(), clock_timestamp()
);

INSERT INTO botmem.workspace_lifecycle_job (
    id, tenant_id, workspace_id, requested_by_user_id, kind, state,
    requested_at, available_at, attempts, max_attempts,
    lease_owner, lease_expires_at
) VALUES (
    'a1510000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'a1520000-0000-4000-8000-000000000001',
    'deletion', 'running', clock_timestamp(), clock_timestamp(),
    8, 8, 'pre-upgrade-lifecycle', clock_timestamp() + interval '5 minutes'
);

INSERT INTO botmem.workspace_billing_cancellation_request (
    job_id, tenant_id, workspace_id, stripe_subscription_id,
    state, attempts, available_at
) VALUES (
    'a1510000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    NULL, 'not_required', 0, clock_timestamp()
);

INSERT INTO botmem.workspace_device_deletion_notice (
    job_id, tenant_id, workspace_id, device_id, state, attempts,
    available_at, lease_owner, lease_expires_at
) VALUES (
    'a1510000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'a1500000-0000-4000-8000-000000000001',
    'a1540000-0000-4000-8000-000000000001',
    'delivering', 5, clock_timestamp(),
    'pre-upgrade-relay', clock_timestamp() + interval '5 minutes'
);

INSERT INTO botmem.stripe_webhook_event (
    id, event_type, event_created_at, object_id, supported, state, attempts,
    received_at, available_at, worker_id, claimed_at, lease_expires_at
) VALUES (
    'evt_upgradefinalattempt', 'invoice.paid', clock_timestamp(),
    'sub_UpgradeFinal123', true, 'processing', 12,
    clock_timestamp(), clock_timestamp(), 'pre-upgrade-commerce',
    clock_timestamp(), clock_timestamp() + interval '5 minutes'
);

RESET ROLE;
\ir ../migration/V15__fenced_worker_leases.sql

SET LOCAL ROLE botmem_schema_owner;
DO $upgrade_reset_replays_interrupted_attempt$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job
         WHERE id = 'a1510000-0000-4000-8000-000000000001'
           AND state = 'retry' AND attempts = 7
           AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM botmem.workspace_device_deletion_notice
         WHERE job_id = 'a1510000-0000-4000-8000-000000000001'
           AND device_id = 'a1540000-0000-4000-8000-000000000001'
           AND state = 'pending' AND attempts = 4
           AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM botmem.stripe_webhook_event
         WHERE id = 'evt_upgradefinalattempt'
           AND state = 'pending' AND attempts = 11
           AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
    ) THEN
        RAISE EXCEPTION 'V15 stranded or consumed an interrupted final attempt';
    END IF;
END
$upgrade_reset_replays_interrupted_attempt$;

SET LOCAL ROLE botmem_lifecycle;
DO $upgrade_lifecycle_final_attempt_claimable$
DECLARE claimed_attempt integer;
BEGIN
    SELECT max(claim.attempts) INTO claimed_attempt
      FROM botmem.claim_workspace_lifecycle_job(
          'post-upgrade-lifecycle', 'a1530000-0000-4000-8000-000000000001',
          clock_timestamp(), clock_timestamp() + interval '5 minutes'
      ) claim;
    IF claimed_attempt IS DISTINCT FROM 8 THEN
        RAISE EXCEPTION 'V15 lifecycle final attempt was not claimable: %', claimed_attempt;
    END IF;
END
$upgrade_lifecycle_final_attempt_claimable$;

SET LOCAL ROLE botmem_api;
DO $upgrade_device_final_attempt_claimable$
DECLARE claimed_attempt integer;
BEGIN
    SELECT max(claim.attempts) INTO claimed_attempt
      FROM botmem.claim_workspace_device_deletion_notice(
          'post-upgrade-relay', 'a1550000-0000-4000-8000-000000000001',
          clock_timestamp() + interval '1 year',
          clock_timestamp() + interval '1 year 1 minute'
      ) claim;
    IF claimed_attempt IS DISTINCT FROM 5 THEN
        RAISE EXCEPTION 'V15 device notice final attempt was not claimable: %', claimed_attempt;
    END IF;
END
$upgrade_device_final_attempt_claimable$;

SET LOCAL ROLE botmem_commerce;
DO $upgrade_webhook_final_attempt_claimable$
DECLARE claimed_attempt integer;
BEGIN
    SELECT max(claim.attempts) INTO claimed_attempt
      FROM botmem.claim_stripe_webhook(
          'post-upgrade-commerce', 'a1560000-0000-4000-8000-000000000001',
          clock_timestamp(), clock_timestamp() + interval '1 minute', 12
      ) claim;
    IF claimed_attempt IS DISTINCT FROM 12 THEN
        RAISE EXCEPTION 'V15 webhook final attempt was not claimable: %', claimed_attempt;
    END IF;
END
$upgrade_webhook_final_attempt_claimable$;

ROLLBACK;
