\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
DO $empty_rls$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.billing_signup) OR
       EXISTS (SELECT 1 FROM botmem.billing_subscription) OR
       EXISTS (SELECT 1 FROM botmem.stripe_webhook_event) THEN
        RAISE EXCEPTION 'commerce rows were visible without an exact capability';
    END IF;
    BEGIN
        INSERT INTO botmem.identity_user (
            id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
        ) VALUES (
            '81000000-0000-4000-8000-000000000002',
            '81000000-0000-4000-8000-000000000001',
            'forbidden@example.test', decode(repeat('8', 64), 'hex'), 'active',
            '2026-07-13T12:00:00Z', '2026-07-13T12:00:00Z'
        );
        RAISE EXCEPTION 'API role unexpectedly provisioned identity data';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$empty_rls$;

SELECT set_config('botmem.billing_signup_id', '81000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.billing_signup (
    id, tenant_id, workspace_id, owner_user_id, owner_email,
    owner_email_lookup_hash, workspace_name, checkout_state,
    created_at, expires_at, updated_at
) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
    'owner@example.test', decode(repeat('1', 64), 'hex'), 'Commerce Test', 'pending',
    '2026-07-13T12:00:00Z', '2026-07-14T12:00:00Z', '2026-07-13T12:00:00Z'
);
UPDATE botmem.billing_signup
   SET stripe_checkout_session_id = 'cs_test_commerce123456',
       checkout_state = 'open', updated_at = '2026-07-13T12:01:00Z'
 WHERE id = '81000000-0000-4000-8000-000000000001';

DO $immutable_checkout$
BEGIN
    BEGIN
        UPDATE botmem.billing_signup
           SET stripe_checkout_session_id = 'cs_test_rebound123456',
               updated_at = '2026-07-13T12:02:00Z'
         WHERE id = '81000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'checkout session binding was mutable';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
END
$immutable_checkout$;

DO $api_cannot_reconcile$
BEGIN
    BEGIN
        PERFORM * FROM botmem.claim_stripe_webhook(
            'forbidden.api', '88000000-0000-4000-8000-000000000001',
            '2026-07-13T12:02:00Z', '2026-07-13T12:03:00Z', 12
        );
        RAISE EXCEPTION 'API role unexpectedly claimed reconciliation work';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM botmem.heartbeat_commerce_reconciler(
            'forbidden.api', '2026-07-13T12:00:00Z', '2026-07-13T12:02:00Z'
        );
        RAISE EXCEPTION 'API role unexpectedly wrote reconciler heartbeat';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$api_cannot_reconcile$;

RESET ROLE;
SET LOCAL ROLE botmem_commerce;
SELECT set_config('botmem.billing_signup_id', '81000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.billing_subscription (
    signup_id, tenant_id, workspace_id, owner_user_id,
    stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id,
    stripe_price_id, quantity, stripe_status, price_matches,
    stripe_observed_at, last_event_created_at, last_event_id,
    current_period_end, provisioned_at, created_at, updated_at
) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
    'cs_test_commerce123456', 'cus_commerce123456', 'sub_commerce123456',
    'price_commerce123456', 1, 'active', true,
    '2026-07-13T12:03:00Z', '2026-07-13T12:02:30Z', 'evt_commerce123456',
    '2026-08-13T12:00:00Z', '2026-07-13T12:03:00Z',
    '2026-07-13T12:00:00Z', '2026-07-13T12:03:00Z'
);

DO $provisioning_history$
BEGIN
    BEGIN
        UPDATE botmem.billing_subscription
           SET provisioned_at = NULL, updated_at = '2026-07-13T12:04:00Z'
         WHERE signup_id = '81000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'provisioning history was removable';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
END
$provisioning_history$;

SELECT set_config('botmem.billing_signup_id', '', true);
DO $signup_hidden$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.billing_signup) OR
       EXISTS (SELECT 1 FROM botmem.billing_subscription) THEN
        RAISE EXCEPTION 'signup capability leaked after it was cleared';
    END IF;
END
$signup_hidden$;

RESET ROLE;
SET LOCAL ROLE botmem_api;

SELECT set_config('botmem.stripe_checkout_session_id', 'cs_test_commerce123456', true);
DO $checkout_capability$
BEGIN
    IF (SELECT count(*) FROM botmem.billing_signup) <> 1 OR
       (SELECT count(*) FROM botmem.billing_subscription) <> 1 THEN
        RAISE EXCEPTION 'exact checkout completion capability did not resolve one signup';
    END IF;
END
$checkout_capability$;
SELECT set_config('botmem.stripe_checkout_session_id', '', true);

SELECT set_config('botmem.stripe_event_id', 'evt_commerce_webhook123456', true);
INSERT INTO botmem.stripe_webhook_event (
    id, event_type, event_created_at, object_id, supported, signup_id,
    stripe_checkout_session_id, stripe_subscription_id, stripe_customer_id,
    state, attempts, received_at, available_at
) VALUES (
    'evt_commerce_webhook123456', 'customer.subscription.updated',
    '2026-07-13T12:05:00Z', 'sub_commerce123456', true,
    '81000000-0000-4000-8000-000000000001', 'cs_test_commerce123456',
    'sub_commerce123456', 'cus_commerce123456', 'pending', 0,
    '2026-07-13T12:05:01Z', '2026-07-13T12:05:01Z'
);
DO $api_cannot_mutate_webhook$
BEGIN
    BEGIN
        UPDATE botmem.stripe_webhook_event
           SET state = 'processed', processed_at = '2026-07-13T12:05:01Z'
         WHERE id = 'evt_commerce_webhook123456';
        RAISE EXCEPTION 'API role unexpectedly mutated a queued webhook';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$api_cannot_mutate_webhook$;

RESET ROLE;
SET LOCAL ROLE botmem_commerce;
SELECT set_config('botmem.stripe_event_id', 'evt_commerce_webhook123456', true);
DO $durable_claim$
DECLARE claimed integer;
BEGIN
    SELECT count(*) INTO claimed FROM botmem.claim_stripe_webhook(
        'commerce.test', '88000000-0000-4000-8000-000000000002',
        '2026-07-13T12:05:02Z', '2026-07-13T12:06:02Z', 12
    );
    IF claimed <> 1 THEN RAISE EXCEPTION 'durable Stripe envelope was not claimed'; END IF;
    SELECT count(*) INTO claimed FROM botmem.claim_stripe_webhook(
        'commerce.other', '88000000-0000-4000-8000-000000000003',
        '2026-07-13T12:05:03Z', '2026-07-13T12:06:03Z', 12
    );
    IF claimed <> 0 THEN RAISE EXCEPTION 'active webhook lease was concurrently claimable'; END IF;
END
$durable_claim$;
UPDATE botmem.stripe_webhook_event
   SET state = 'processed', worker_id = NULL, claimed_at = NULL,
       lease_token = NULL, lease_expires_at = NULL,
       processed_at = '2026-07-13T12:05:04Z'
 WHERE id = 'evt_commerce_webhook123456';
SELECT botmem.heartbeat_commerce_reconciler(
    'commerce.test', '2026-07-13T12:00:00Z', '2026-07-13T12:05:05Z'
);
DO $worker_readiness$
BEGIN
    IF NOT botmem.commerce_reconciler_ready('2026-07-13T12:05:10Z', 30) THEN
        RAISE EXCEPTION 'fresh commerce worker heartbeat was not ready';
    END IF;
    IF botmem.commerce_reconciler_ready('2026-07-13T12:06:00Z', 30) THEN
        RAISE EXCEPTION 'stale commerce worker heartbeat remained ready';
    END IF;
END
$worker_readiness$;
SELECT set_config('botmem.stripe_event_id', 'evt_other_webhook123456', true);
DO $event_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.stripe_webhook_event) THEN
        RAISE EXCEPTION 'webhook idempotency row leaked across exact event capability';
    END IF;
END
$event_isolation$;
RESET ROLE;

SET LOCAL ROLE botmem_identity_admin;
DO $commerce_denied$
BEGIN
    BEGIN
        PERFORM * FROM botmem.billing_signup;
        RAISE EXCEPTION 'identity admin unexpectedly read commerce state';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$commerce_denied$;

INSERT INTO botmem.identity_user (
    id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
) VALUES (
    '81000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000001',
    'owner@example.test', decode(repeat('1', 64), 'hex'), 'active',
    '2026-07-13T12:03:00Z', '2026-07-13T12:03:00Z'
);
INSERT INTO botmem.workspace (
    id, tenant_id, display_name, status, created_at, updated_at
) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'Commerce Test', 'active', '2026-07-13T12:03:00Z', '2026-07-13T12:03:00Z'
);
INSERT INTO botmem.workspace_membership (
    tenant_id, workspace_id, user_id, role, status, created_at, updated_at
) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
    'owner', 'active', '2026-07-13T12:03:00Z', '2026-07-13T12:03:00Z'
);
RESET ROLE;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '81000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '81000000-0000-4000-8000-000000000001', true);
DO $tenant_entitlement$
BEGIN
    IF (SELECT count(*) FROM botmem.billing_subscription
        WHERE stripe_status IN ('active', 'trialing')
          AND stripe_price_id = 'price_commerce123456'
          AND price_matches AND provisioned_at IS NOT NULL) <> 1 THEN
        RAISE EXCEPTION 'provisioned active entitlement was not tenant-readable';
    END IF;
END
$tenant_entitlement$;
SELECT set_config('botmem.tenant_id', '82000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '82000000-0000-4000-8000-000000000001', true);
DO $tenant_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.billing_subscription) THEN
        RAISE EXCEPTION 'billing entitlement crossed workspace RLS';
    END IF;
END
$tenant_isolation$;
RESET ROLE;

ROLLBACK;
