\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.workspace (
    id, tenant_id, display_name, status, created_at, updated_at
) VALUES
(
    'd1310000-0000-4000-8000-000000000001',
    'd1310000-0000-4000-8000-000000000001',
    'Pending cancellation', 'deleting',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    'd1310000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'No subscription', 'deleting',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    'd1310000-0000-4000-8000-000000000003',
    'd1310000-0000-4000-8000-000000000003',
    'Expired blocked lease', 'deleting',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.workspace_lifecycle_job (
    id, tenant_id, workspace_id, requested_by_user_id, kind, state,
    requested_at, available_at, attempts, max_attempts,
    lease_owner, lease_token, lease_expires_at
) VALUES
(
    'd1320000-0000-4000-8000-000000000001',
    'd1310000-0000-4000-8000-000000000001',
    'd1310000-0000-4000-8000-000000000001',
    'd1330000-0000-4000-8000-000000000001',
    'deletion', 'running', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z',
    1, 5, 'v13.pending', 'd1350000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '5 minutes'
),
(
    'd1320000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'd1330000-0000-4000-8000-000000000002',
    'deletion', 'queued', '2026-07-13T10:01:00Z', '2026-07-13T10:01:00Z',
    0, 5, NULL, NULL, NULL
),
(
    'd1320000-0000-4000-8000-000000000003',
    'd1310000-0000-4000-8000-000000000003',
    'd1310000-0000-4000-8000-000000000003',
    'd1330000-0000-4000-8000-000000000003',
    'deletion', 'running', '2026-07-13T09:00:00Z', '2026-07-13T09:00:00Z',
    5, 5, 'v13.crashed', 'd1350000-0000-4000-8000-000000000003',
    '2026-07-13T09:59:00Z'
);

INSERT INTO botmem.workspace_billing_cancellation_request (
    job_id, tenant_id, workspace_id, stripe_subscription_id,
    state, attempts, available_at
) VALUES
(
    'd1320000-0000-4000-8000-000000000001',
    'd1310000-0000-4000-8000-000000000001',
    'd1310000-0000-4000-8000-000000000001',
    'sub_V13Pending123', 'pending', 0, '2026-07-13T10:00:00Z'
),
(
    'd1320000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    NULL, 'not_required', 0, '2026-07-13T10:01:00Z'
),
(
    'd1320000-0000-4000-8000-000000000003',
    'd1310000-0000-4000-8000-000000000003',
    'd1310000-0000-4000-8000-000000000003',
    'sub_V13Expired123', 'not_required', 5, '2026-07-13T11:00:00Z'
);

INSERT INTO botmem.workspace_device_deletion_notice (
    job_id, tenant_id, workspace_id, device_id, state, attempts, available_at
) VALUES (
    'd1320000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'd1310000-0000-4000-8000-000000000002',
    'd1340000-0000-4000-8000-000000000002',
    'pending', 0, '2026-07-13T10:01:00Z'
);

SET LOCAL ROLE botmem_lifecycle;
DO $pending_cannot_erase$
BEGIN
    IF botmem.complete_workspace_deletion(
            'd1320000-0000-4000-8000-000000000001',
            'v13.pending', 'd1350000-0000-4000-8000-000000000001',
            '2026-07-13T10:00:01Z'
        ) THEN
        RAISE EXCEPTION 'workspace erased before billing cancellation settled';
    END IF;
END
$pending_cannot_erase$;

SET LOCAL ROLE botmem_schema_owner;
DO $pending_erase_rolled_back$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace
         WHERE id = 'd1310000-0000-4000-8000-000000000001'
           AND status = 'deleting'
    ) OR EXISTS (
        SELECT 1 FROM botmem.workspace_deleted_billing_audit
         WHERE job_id = 'd1320000-0000-4000-8000-000000000001'
    ) THEN
        RAISE EXCEPTION 'rejected erasure was not rolled back atomically';
    END IF;
END
$pending_erase_rolled_back$;

SET LOCAL ROLE botmem_lifecycle;
DO $defer_pending_deletion$
BEGIN
    IF NOT botmem.defer_workspace_deletion(
        'd1320000-0000-4000-8000-000000000001',
        'v13.pending', 'd1350000-0000-4000-8000-000000000001',
        '2026-07-13T10:00:02Z',
        '2026-07-13T10:00:32Z', 'BILLING_CANCELLATION_PENDING'
    ) THEN
        RAISE EXCEPTION 'blocked lifecycle deletion was not deferred';
    END IF;
END
$defer_pending_deletion$;

SET LOCAL ROLE botmem_schema_owner;
DO $deferred_without_attempt$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job
         WHERE id = 'd1320000-0000-4000-8000-000000000001'
           AND state = 'retry' AND attempts = 0
           AND available_at = '2026-07-13T10:00:32Z'
           AND failure_code = 'BILLING_CANCELLATION_PENDING'
    ) THEN
        RAISE EXCEPTION 'deletion deferral consumed an attempt or lost its safe reason';
    END IF;
END
$deferred_without_attempt$;

SET LOCAL ROLE botmem_lifecycle;
DO $expired_blocked_lease$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'v13.claim', 'd1350000-0000-4000-8000-000000000004',
        '2026-07-13T10:00:03Z', '2026-07-13T10:05:03Z'
    );
    IF claimed.job_id IS NOT NULL THEN
        RAISE EXCEPTION 'unsettled deletion was claimable';
    END IF;
END
$expired_blocked_lease$;

SET LOCAL ROLE botmem_schema_owner;
DO $expired_blocked_state$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job
         WHERE id = 'd1320000-0000-4000-8000-000000000003'
           AND state = 'retry' AND attempts = 4
           AND available_at = '2026-07-13T10:00:33Z'
           AND failure_code = 'BILLING_CANCELLATION_PENDING'
    ) THEN
        RAISE EXCEPTION 'expired blocked lease exhausted or spun its lifecycle budget';
    END IF;
END
$expired_blocked_state$;

SET LOCAL ROLE botmem_commerce;
DO $commerce_cannot_defer$
BEGIN
    BEGIN
        PERFORM botmem.defer_workspace_deletion(
            'd1320000-0000-4000-8000-000000000001',
            'v13.pending', 'd1350000-0000-4000-8000-000000000001',
            '2026-07-13T10:00:04Z',
            '2026-07-13T10:00:34Z', 'BILLING_CANCELLATION_PENDING'
        );
        RAISE EXCEPTION 'commerce crossed into lifecycle deferral authority';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$commerce_cannot_defer$;

DO $schedule_cancellation_retry$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_billing_cancellation(
        'v13.commerce', 'd1350000-0000-4000-8000-000000000005',
        '2026-07-13T10:00:10Z', '2026-07-13T10:01:10Z', 2
    );
    IF claimed.job_id <> 'd1320000-0000-4000-8000-000000000001' OR
       claimed.attempts <> 1 THEN
        RAISE EXCEPTION 'billing cancellation was not claimed';
    END IF;
    IF botmem.fail_workspace_billing_cancellation(
        claimed.job_id, 'v13.commerce', claimed.lease_token,
        '2026-07-13T10:00:11Z',
        '2026-07-13T10:00:21Z', 2, 'STRIPE_CANCELLATION_FAILED'
    ) <> 'pending' THEN
        RAISE EXCEPTION 'billing cancellation failure was not retried';
    END IF;
END
$schedule_cancellation_retry$;

SET LOCAL ROLE botmem_schema_owner;
DO $durable_retry_reason$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_billing_cancellation_request
         WHERE job_id = 'd1320000-0000-4000-8000-000000000001'
           AND state = 'pending' AND attempts = 1
           AND available_at = '2026-07-13T10:00:21Z'
           AND failure_code = 'STRIPE_CANCELLATION_FAILED'
    ) THEN
        RAISE EXCEPTION 'billing retry reason was not durably observable';
    END IF;
END
$durable_retry_reason$;

SET LOCAL ROLE botmem_commerce;
DO $confirm_cancellation_retry$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_billing_cancellation(
        'v13.commerce', 'd1350000-0000-4000-8000-000000000006',
        '2026-07-13T10:00:21Z', '2026-07-13T10:01:21Z', 2
    );
    IF claimed.attempts <> 2 OR NOT botmem.confirm_workspace_billing_cancellation(
        claimed.job_id, 'v13.commerce', claimed.lease_token,
        '2026-07-13T10:00:22Z', 'canceled'
    ) THEN
        RAISE EXCEPTION 'billing cancellation did not recover and confirm';
    END IF;
END
$confirm_cancellation_retry$;

SET LOCAL ROLE botmem_lifecycle;
DO $settled_deletions_complete$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'v13.lifecycle', 'd1350000-0000-4000-8000-000000000007',
        '2026-07-13T10:00:32Z', '2026-07-13T10:05:32Z'
    );
    IF claimed.job_id <> 'd1320000-0000-4000-8000-000000000001' OR
       NOT botmem.complete_workspace_deletion(
           claimed.job_id, 'v13.lifecycle', claimed.lease_token,
           '2026-07-13T10:00:33Z'
       ) THEN
        RAISE EXCEPTION 'confirmed cancellation did not release hosted deletion';
    END IF;

    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'v13.lifecycle', 'd1350000-0000-4000-8000-000000000008',
        '2026-07-13T10:01:00Z', '2026-07-13T10:06:00Z'
    );
    IF claimed.job_id <> 'd1320000-0000-4000-8000-000000000002' OR
       NOT botmem.complete_workspace_deletion(
           claimed.job_id, 'v13.lifecycle', claimed.lease_token,
           '2026-07-13T10:01:01Z'
       ) THEN
        RAISE EXCEPTION 'no-subscription deletion did not complete';
    END IF;
END
$settled_deletions_complete$;

SET LOCAL ROLE botmem_schema_owner;
DO $final_state$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_deleted_billing_audit
         WHERE job_id = 'd1320000-0000-4000-8000-000000000001'
           AND cancellation_state = 'confirmed'
    ) OR NOT EXISTS (
        SELECT 1 FROM botmem.workspace_deleted_billing_audit
         WHERE job_id = 'd1320000-0000-4000-8000-000000000002'
           AND cancellation_state = 'not_required'
    ) THEN
        RAISE EXCEPTION 'settled deletion audit evidence is incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_device_deletion_notice
         WHERE job_id = 'd1320000-0000-4000-8000-000000000002'
           AND state = 'pending'
    ) THEN
        RAISE EXCEPTION 'offline device deletion ceased to be best effort';
    END IF;
END
$final_state$;

ROLLBACK;
