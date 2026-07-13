\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
SELECT set_config(
    'botmem.billing_signup_id',
    'a1400000-0000-4000-8000-000000000001',
    true
);
INSERT INTO botmem.billing_signup (
    id, tenant_id, workspace_id, owner_user_id, owner_email,
    owner_email_lookup_hash, workspace_name, stripe_checkout_session_id,
    checkout_state, created_at, expires_at, updated_at
) VALUES (
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000002',
    'stripe-precision@example.test', decode(repeat('a', 64), 'hex'),
    'Stripe precision invariant', 'cs_test_secondprecision123456', 'open',
    '2026-07-13T12:00:00.900Z', '2026-07-14T12:00:00Z',
    '2026-07-13T12:00:00.900Z'
);

RESET ROLE;
SET LOCAL ROLE botmem_commerce;
SELECT set_config(
    'botmem.billing_signup_id',
    'a1400000-0000-4000-8000-000000000001',
    true
);

-- Stripe serializes this event as 12:00:00 even though it was emitted after
-- the signup's 12:00:00.900 database timestamp.
INSERT INTO botmem.billing_subscription (
    signup_id, tenant_id, workspace_id, owner_user_id,
    stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id,
    stripe_price_id, quantity, stripe_status, price_matches,
    stripe_observed_at, last_event_created_at, last_event_id,
    current_period_end, provisioned_at, created_at, updated_at
) VALUES (
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000001',
    'a1400000-0000-4000-8000-000000000002',
    'cs_test_secondprecision123456', 'cus_secondprecision123456',
    'sub_secondprecision123456', 'price_secondprecision123456',
    1, 'active', true,
    '2026-07-13T12:00:00.950Z', '2026-07-13T12:00:00Z',
    'evt_secondprecision123456', '2026-08-13T12:00:00Z',
    '2026-07-13T12:00:00.950Z', '2026-07-13T12:00:00.900Z',
    '2026-07-13T12:00:00.950Z'
);

DO $prior_second_rejected$
BEGIN
    BEGIN
        UPDATE botmem.billing_subscription
           SET last_event_created_at = '2026-07-13T11:59:59.999Z',
               last_event_id = 'evt_secondprecisionolder123456',
               updated_at = '2026-07-13T12:00:01Z'
         WHERE signup_id = 'a1400000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'an event from a prior second was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END
$prior_second_rejected$;

DO $same_second_persisted$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM botmem.billing_subscription
         WHERE signup_id = 'a1400000-0000-4000-8000-000000000001'
           AND last_event_created_at = '2026-07-13T12:00:00Z'
    ) THEN
        RAISE EXCEPTION 'same-second Stripe event did not persist';
    END IF;
END
$same_second_persisted$;

ROLLBACK;
