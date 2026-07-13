\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.workspace (id, tenant_id, display_name, status, created_at, updated_at) VALUES
('f1500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
 'Fenced deletion', 'deleting', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'),
('f1500000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000002',
 'Fenced billing', 'deleting', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z');
INSERT INTO botmem.workspace_lifecycle_job (
    id, tenant_id, workspace_id, requested_by_user_id, kind, state,
    requested_at, available_at, attempts, max_attempts
) VALUES
('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
 'f1500000-0000-4000-8000-000000000001', 'f1520000-0000-4000-8000-000000000001',
 'deletion', 'queued', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', 0, 8),
('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000002',
 'f1500000-0000-4000-8000-000000000002', 'f1520000-0000-4000-8000-000000000002',
 'deletion', 'queued', '2026-07-13T10:01:00Z', '2026-07-13T10:01:00Z', 0, 8);
INSERT INTO botmem.workspace_billing_cancellation_request (
    job_id, tenant_id, workspace_id, stripe_subscription_id, state, attempts, available_at
) VALUES
('f1510000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001',
 'f1500000-0000-4000-8000-000000000001', NULL, 'not_required', 0, '2026-07-13T10:00:00Z'),
('f1510000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000002',
 'f1500000-0000-4000-8000-000000000002', 'sub_FencedLease123', 'pending', 0,
 '2026-07-13T10:01:00Z');

-- Reuse the same process ID after expiration. Only the fresh UUID may pass the
-- final destructive predicate or complete the erase.
SET LOCAL ROLE botmem_lifecycle;
SELECT * FROM botmem.claim_workspace_lifecycle_job(
    'same.lifecycle', 'f1530000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z', '2026-07-13T10:01:00Z'
);
SET LOCAL ROLE botmem_schema_owner;
UPDATE botmem.workspace_lifecycle_job SET lease_expires_at = '2026-07-13T10:00:59Z'
 WHERE id = 'f1510000-0000-4000-8000-000000000001';
SET LOCAL ROLE botmem_lifecycle;
DO $expired_unreclaimed_token_fenced$
BEGIN
    IF botmem.complete_workspace_deletion(
        'f1510000-0000-4000-8000-000000000001', 'same.lifecycle',
        'f1530000-0000-4000-8000-000000000001', '2026-07-13T10:01:00Z'
    ) THEN
        RAISE EXCEPTION 'expired unreclaimed lifecycle token completed deletion';
    END IF;
END
$expired_unreclaimed_token_fenced$;
SELECT * FROM botmem.claim_workspace_lifecycle_job(
    'same.lifecycle', 'f1530000-0000-4000-8000-000000000002',
    '2026-07-13T10:01:00Z', '2026-07-13T10:06:00Z'
);
DO $stale_deletion_fenced$
BEGIN
    IF botmem.authorize_workspace_destruction(
        'f1510000-0000-4000-8000-000000000001', 'same.lifecycle',
        'f1530000-0000-4000-8000-000000000001',
        '2026-07-13T10:01:01Z', '2026-07-13T10:06:01Z'
    ) OR botmem.complete_workspace_deletion(
        'f1510000-0000-4000-8000-000000000001', 'same.lifecycle',
        'f1530000-0000-4000-8000-000000000001', '2026-07-13T10:01:01Z'
    ) THEN
        RAISE EXCEPTION 'expired lifecycle token authorized destructive deletion';
    END IF;
END
$stale_deletion_fenced$;
SET LOCAL ROLE botmem_schema_owner;
DO $workspace_survived_stale_erase$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM botmem.workspace WHERE id = 'f1500000-0000-4000-8000-000000000001') THEN
        RAISE EXCEPTION 'stale lifecycle worker erased a reclaimed workspace';
    END IF;
END
$workspace_survived_stale_erase$;
SET LOCAL ROLE botmem_lifecycle;
DO $current_deletion_token_works$
BEGIN
    IF NOT botmem.authorize_workspace_destruction(
        'f1510000-0000-4000-8000-000000000001', 'same.lifecycle',
        'f1530000-0000-4000-8000-000000000002',
        '2026-07-13T10:01:02Z', '2026-07-13T10:06:02Z'
    ) OR NOT botmem.complete_workspace_deletion(
        'f1510000-0000-4000-8000-000000000001', 'same.lifecycle',
        'f1530000-0000-4000-8000-000000000002', '2026-07-13T10:01:03Z'
    ) THEN
        RAISE EXCEPTION 'current lifecycle token could not complete deletion';
    END IF;
END
$current_deletion_token_works$;

SET LOCAL ROLE botmem_commerce;
SELECT * FROM botmem.claim_workspace_billing_cancellation(
    'same.commerce', 'f1540000-0000-4000-8000-000000000001',
    '2026-07-13T10:01:00Z', '2026-07-13T10:02:00Z', 12
);
SET LOCAL ROLE botmem_schema_owner;
UPDATE botmem.workspace_billing_cancellation_request
   SET lease_expires_at = '2026-07-13T10:01:59Z'
 WHERE job_id = 'f1510000-0000-4000-8000-000000000002';
SET LOCAL ROLE botmem_commerce;
SELECT * FROM botmem.claim_workspace_billing_cancellation(
    'same.commerce', 'f1540000-0000-4000-8000-000000000002',
    '2026-07-13T10:02:00Z', '2026-07-13T10:03:00Z', 12
);
DO $billing_token_fenced$
BEGIN
    IF botmem.confirm_workspace_billing_cancellation(
        'f1510000-0000-4000-8000-000000000002', 'same.commerce',
        'f1540000-0000-4000-8000-000000000001', '2026-07-13T10:02:01Z', 'canceled'
    ) OR NOT botmem.confirm_workspace_billing_cancellation(
        'f1510000-0000-4000-8000-000000000002', 'same.commerce',
        'f1540000-0000-4000-8000-000000000002', '2026-07-13T10:02:02Z', 'canceled'
    ) THEN
        RAISE EXCEPTION 'billing cancellation fencing failed for reused worker ID';
    END IF;
END
$billing_token_fenced$;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.stripe_event_id', 'evt_fencedlease123456', true);
INSERT INTO botmem.stripe_webhook_event (
    id, event_type, event_created_at, object_id, supported, state, attempts,
    received_at, available_at
) VALUES ('evt_fencedlease123456', 'invoice.paid', '2026-07-13T10:00:00Z',
          'sub_FencedLease123', true, 'pending', 0,
          '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z');
SET LOCAL ROLE botmem_commerce;
SELECT set_config('botmem.stripe_event_id', 'evt_fencedlease123456', true);
SELECT * FROM botmem.claim_stripe_webhook(
    'same.webhook', 'f1550000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z', '2026-07-13T10:01:00Z', 12
);
SET LOCAL ROLE botmem_schema_owner;
UPDATE botmem.stripe_webhook_event SET lease_expires_at = '2026-07-13T10:00:59Z'
 WHERE id = 'evt_fencedlease123456';
SET LOCAL ROLE botmem_commerce;
SELECT set_config('botmem.stripe_event_id', 'evt_fencedlease123456', true);
SELECT * FROM botmem.claim_stripe_webhook(
    'same.webhook', 'f1550000-0000-4000-8000-000000000002',
    '2026-07-13T10:01:00Z', '2026-07-13T10:02:00Z', 12
);
UPDATE botmem.stripe_webhook_event
   SET state = 'processed', worker_id = NULL, claimed_at = NULL,
       lease_token = NULL, lease_expires_at = NULL,
       processed_at = '2026-07-13T10:01:01Z'
 WHERE id = 'evt_fencedlease123456' AND state = 'processing'
   AND worker_id = 'same.webhook'
   AND lease_token = 'f1550000-0000-4000-8000-000000000001';
DO $webhook_token_fenced$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.stripe_webhook_event
         WHERE id = 'evt_fencedlease123456' AND state = 'processing'
           AND lease_token = 'f1550000-0000-4000-8000-000000000002'
    ) THEN
        RAISE EXCEPTION 'webhook fencing failed for reused worker ID';
    END IF;
END
$webhook_token_fenced$;

ROLLBACK;
