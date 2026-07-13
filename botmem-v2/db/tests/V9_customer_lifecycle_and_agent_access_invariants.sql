\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_identity_admin;
INSERT INTO botmem.identity_user (
    id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
) VALUES
(
    '91100000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'lifecycle-a@example.com', decode(repeat('a1', 32), 'hex'), 'active',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    '91100000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    'lifecycle-b@example.com', decode(repeat('b2', 32), 'hex'), 'active',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.workspace (
    id, tenant_id, display_name, status, created_at, updated_at
) VALUES
(
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'Lifecycle A', 'active', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    'Lifecycle B', 'active', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.workspace_membership (
    tenant_id, workspace_id, user_id, role, status, created_at, updated_at
) VALUES
(
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    'owner', 'active', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
),
(
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    '91100000-0000-4000-8000-000000000002',
    'owner', 'active', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

DO $global_email_uniqueness$
BEGIN
    BEGIN
        INSERT INTO botmem.identity_user (
            id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
        ) VALUES (
            '91100000-0000-4000-8000-000000000003',
            '91000000-0000-4000-8000-000000000002',
            'duplicate@example.com', decode(repeat('a1', 32), 'hex'), 'active',
            '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
        );
        RAISE EXCEPTION 'active email lookup hash was not globally unique';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END
$global_email_uniqueness$;

RESET ROLE;
INSERT INTO botmem.billing_signup (
    id, tenant_id, workspace_id, owner_user_id, owner_email,
    owner_email_lookup_hash, workspace_name, stripe_checkout_session_id,
    checkout_state, created_at, expires_at, updated_at
) VALUES (
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    'billing-owner@example.com', decode(repeat('e1', 32), 'hex'),
    'Private Workspace Name', 'cs_test_Lifecycle123', 'complete',
    '2026-07-13T10:00:00Z', '2026-07-13T11:00:00Z', '2026-07-13T10:01:00Z'
);
INSERT INTO botmem.billing_subscription (
    signup_id, tenant_id, workspace_id, owner_user_id,
    stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id,
    stripe_price_id, quantity, stripe_status, price_matches,
    stripe_observed_at, last_event_created_at, last_event_id,
    current_period_end, provisioned_at, created_at, updated_at
) VALUES (
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    'cs_test_Lifecycle123', 'cus_Lifecycle123', 'sub_OutageRecovery123',
    'price_Lifecycle123', 1, 'active', true,
    '2026-07-13T10:01:00Z', '2026-07-13T10:01:00Z', 'evt_Lifecycle123',
    '2026-08-13T10:00:00Z', '2026-07-13T10:01:00Z',
    '2026-07-13T10:00:00Z', '2026-07-13T10:01:00Z'
);
INSERT INTO botmem.stripe_webhook_event (
    id, event_type, event_created_at, object_id, supported, signup_id,
    stripe_checkout_session_id, stripe_subscription_id, stripe_customer_id,
    state, attempts, received_at, available_at, processed_at
) VALUES (
    'evt_Lifecycle123', 'customer.subscription.updated',
    '2026-07-13T10:01:00Z', 'sub_OutageRecovery123', true,
    '91000000-0000-4000-8000-000000000001', 'cs_test_Lifecycle123',
    'sub_OutageRecovery123', 'cus_Lifecycle123', 'processed', 1,
    '2026-07-13T10:01:00Z', '2026-07-13T10:01:00Z', '2026-07-13T10:01:01Z'
);
SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.user_id', '91100000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.identity_credential (
    id, tenant_id, workspace_id, user_id, kind, secret_hash, token_prefix,
    label, scopes, created_at, expires_at
) VALUES
(
    '91200000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    'browser_session', decode(repeat('c1', 32), 'hex'), 'BrowserA1234',
    'Browser session', ARRAY['browser'],
    '2026-07-13T10:00:00Z', '2026-07-20T10:00:00Z'
),
(
    '91300000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    'personal_access_token', decode(repeat('d1', 32), 'hex'), 'AgentA123456',
    'Codex CLI', ARRAY['botmem:search'],
    '2026-07-13T10:00:00Z', '2026-07-20T10:00:00Z'
);
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash,
    credential_ref, status, aggregate_version, created_at, updated_at
) VALUES (
    '91400000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'gmail', 'oauth2', repeat('1', 64), 'vault:lifecycle-a', 'ready', 1,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.device_registry (
    id, tenant_id, workspace_id, display_name, key_id, public_key,
    connectors, status, credential_version, created_at, updated_at
) VALUES (
    '91600000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'Lifecycle Mac', 'lifecycle-key', decode(repeat('11', 32), 'hex'),
    ARRAY['imessage'], 'active', 1,
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

SELECT set_config('botmem.tenant_id', '91000000-0000-4000-8000-000000000002', true);
SELECT set_config('botmem.workspace_id', '91000000-0000-4000-8000-000000000002', true);
SELECT set_config('botmem.user_id', '91100000-0000-4000-8000-000000000002', true);
INSERT INTO botmem.identity_credential (
    id, tenant_id, workspace_id, user_id, kind, secret_hash, token_prefix,
    label, scopes, created_at, expires_at
) VALUES
(
    '91200000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    '91100000-0000-4000-8000-000000000002',
    'browser_session', decode(repeat('c2', 32), 'hex'), 'BrowserB1234',
    'Browser session', ARRAY['browser'],
    '2026-07-13T10:00:00Z', '2026-07-20T10:00:00Z'
),
(
    '91300000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000002',
    '91100000-0000-4000-8000-000000000002',
    'personal_access_token', decode(repeat('d2', 32), 'hex'), 'AgentB123456',
    'Other tenant', ARRAY['botmem:search'],
    '2026-07-13T10:00:00Z', '2026-07-20T10:00:00Z'
);

RESET ROLE;
SET LOCAL ROLE botmem_worker;
SELECT set_config('botmem.tenant_id', '91000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.ingest_event_revision (
    id, tenant_id, account_id, source_event_id, source_revision, kind,
    occurred_at, observed_at, content_hash, payload, tombstone
) VALUES (
    '91500000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '91400000-0000-4000-8000-000000000001',
    'message-1', 'revision-1', 'email',
    '2026-07-12T10:00:00Z', '2026-07-13T10:00:00Z', repeat('f', 64),
    '{"subject":"Lifecycle export","body":"Hosted only"}'::jsonb, false
);
INSERT INTO botmem.ingest_event_head (
    tenant_id, account_id, source_event_id, head_revision_id, updated_at
) VALUES (
    '91000000-0000-4000-8000-000000000001',
    '91400000-0000-4000-8000-000000000001',
    'message-1', '91500000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z'
);

RESET ROLE;
SET LOCAL ROLE botmem_api;
DO $email_only_login$
DECLARE
    accepted boolean;
BEGIN
    SELECT botmem.consume_identity_login_rate_limit(
        decode(repeat('01', 32), 'hex'), '2026-07-13T10:01:00Z', 2, 900
    ) INTO accepted;
    IF NOT accepted THEN RAISE EXCEPTION 'first login rate attempt was denied'; END IF;
    SELECT botmem.consume_identity_login_rate_limit(
        decode(repeat('01', 32), 'hex'), '2026-07-13T10:01:01Z', 2, 900
    ) INTO accepted;
    IF NOT accepted THEN RAISE EXCEPTION 'second login rate attempt was denied'; END IF;
    SELECT botmem.consume_identity_login_rate_limit(
        decode(repeat('01', 32), 'hex'), '2026-07-13T10:01:02Z', 2, 900
    ) INTO accepted;
    IF accepted THEN RAISE EXCEPTION 'login rate limit did not close'; END IF;

    SELECT botmem.begin_identity_login_challenge(
        decode(repeat('a1', 32), 'hex'),
        '91900000-0000-4000-8000-000000000001',
        decode(repeat('e1', 32), 'hex'),
        '2026-07-13T10:01:00Z', '2026-07-13T10:16:00Z'
    ) INTO accepted;
    IF NOT accepted THEN RAISE EXCEPTION 'global email login did not resolve'; END IF;
    SELECT botmem.begin_identity_login_challenge(
        decode(repeat('a1', 32), 'hex'),
        '91900000-0000-4000-8000-000000000002',
        decode(repeat('e2', 32), 'hex'),
        '2026-07-13T10:01:30Z', '2026-07-13T10:16:30Z'
    ) INTO accepted;
    IF accepted THEN RAISE EXCEPTION 'email delivery cooldown was bypassed'; END IF;
    SELECT botmem.begin_identity_login_challenge(
        decode(repeat('ff', 32), 'hex'),
        '91900000-0000-4000-8000-000000000003',
        decode(repeat('e3', 32), 'hex'),
        '2026-07-13T10:01:00Z', '2026-07-13T10:16:00Z'
    ) INTO accepted;
    IF accepted THEN RAISE EXCEPTION 'unknown email produced a challenge'; END IF;
END
$email_only_login$;

SELECT set_config('botmem.tenant_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.user_id', '91100000-0000-4000-8000-000000000001', true);
DO $pat_owner_scope$
DECLARE
    revoked boolean;
BEGIN
    IF (SELECT count(*) FROM botmem.identity_credential
         WHERE kind = 'personal_access_token' AND revoked_at IS NULL) <> 1 THEN
        RAISE EXCEPTION 'PAT metadata escaped exact owner RLS';
    END IF;
    SELECT botmem.revoke_owned_personal_access_token(
        '91200000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '91300000-0000-4000-8000-000000000002',
        '2026-07-13T10:05:00Z'
    ) INTO revoked;
    IF revoked THEN RAISE EXCEPTION 'cross-tenant PAT was revoked'; END IF;
    SELECT botmem.revoke_owned_personal_access_token(
        '91300000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '91300000-0000-4000-8000-000000000001',
        '2026-07-13T10:05:00Z'
    ) INTO revoked;
    RAISE EXCEPTION 'PAT actor unexpectedly managed PATs';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END
$pat_owner_scope$;

DO $browser_revokes_own_pat$
DECLARE
    revoked boolean;
BEGIN
    SELECT botmem.revoke_owned_personal_access_token(
        '91200000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '91300000-0000-4000-8000-000000000001',
        '2026-07-13T10:05:00Z'
    ) INTO revoked;
    IF NOT revoked THEN RAISE EXCEPTION 'browser owner could not revoke own PAT'; END IF;
END
$browser_revokes_own_pat$;

DO $request_export$
DECLARE
    job_id uuid;
BEGIN
    SELECT botmem.request_workspace_export(
        '91700000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '2026-07-13T10:06:00Z', 8
    ) INTO job_id;
    IF job_id <> '91700000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'export request did not return its durable job';
    END IF;
END
$request_export$;

RESET ROLE;
SET LOCAL ROLE botmem_lifecycle;
DO $bounded_export$
DECLARE
    claimed record;
    exported record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'lifecycle-test', '99000000-0000-4000-8000-000000000001',
        '2026-07-13T10:06:01Z', '2026-07-13T10:11:01Z'
    );
    IF claimed.job_id <> '91700000-0000-4000-8000-000000000001' OR
       claimed.kind <> 'export' THEN
        RAISE EXCEPTION 'export job was not claimed by lifecycle role';
    END IF;
    SELECT * INTO exported FROM botmem.read_workspace_export_page(
        claimed.job_id, 'lifecycle-test', claimed.lease_token,
        '2026-07-13T10:06:02Z', NULL, NULL, 100
    );
    IF exported.source_event_id <> 'message-1' OR
       exported.payload->>'subject' <> 'Lifecycle export' THEN
        RAISE EXCEPTION 'hosted export page was incomplete';
    END IF;
    IF row_to_json(exported)::text ~ '(content_hash|projection_hash|ciphertext|secret_hash)' THEN
        RAISE EXCEPTION 'hosted export exposed internal hash or ciphertext fields';
    END IF;
    IF NOT botmem.complete_workspace_export(
        claimed.job_id, 'lifecycle-test', claimed.lease_token,
        '2026-07-13T10:07:00Z',
        '91000000-0000-4000-8000-000000000001/91700000-0000-4000-8000-000000000001.bme',
        '2026-07-14T10:07:00Z'
    ) THEN
        RAISE EXCEPTION 'export completion failed';
    END IF;
END
$bounded_export$;

RESET ROLE;
SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '91000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.user_id', '91100000-0000-4000-8000-000000000001', true);
DO $request_deletion$
DECLARE
    job_id uuid;
    artifact text;
BEGIN
    SELECT botmem.consume_workspace_export_artifact(
        '91700000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '2026-07-13T10:08:00Z'
    ) INTO artifact;
    IF artifact IS NULL THEN RAISE EXCEPTION 'ready export could not be downloaded'; END IF;
    IF botmem.consume_workspace_export_artifact(
        '91700000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '2026-07-13T10:08:01Z'
    ) IS DISTINCT FROM artifact THEN
        RAISE EXCEPTION 'repeat export download did not preserve the artifact locator';
    END IF;
    SELECT botmem.request_workspace_export(
        '91700000-0000-4000-8000-000000000099',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '2026-07-13T10:08:02Z', 8
    ) INTO job_id;
    IF job_id <> '91700000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'ready export request did not remain idempotent';
    END IF;
    SELECT botmem.request_workspace_deletion(
        '91800000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000001',
        '91100000-0000-4000-8000-000000000001',
        '2026-07-13T10:09:00Z', 8
    ) INTO job_id;
    IF job_id <> '91800000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'deletion request was not durable';
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.identity_credential
         WHERE tenant_id = '91000000-0000-4000-8000-000000000001'
           AND revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'deletion request left hosted credentials active';
    END IF;
END
$request_deletion$;

RESET ROLE;
UPDATE botmem.workspace_billing_cancellation_request
   SET state = 'pending', stripe_subscription_id = 'sub_OutageRecovery123',
       available_at = '2026-07-13T10:09:00Z'
 WHERE job_id = '91800000-0000-4000-8000-000000000001';
SET LOCAL ROLE botmem_api;
DO $api_relay$
DECLARE
    notice record;
BEGIN
    SELECT * INTO notice FROM botmem.claim_workspace_device_deletion_notice(
        'api-relay-test', '99000000-0000-4000-8000-000000000002',
        '2026-07-13T10:09:01Z', '2026-07-13T10:09:31Z'
    );
    IF notice.device_id <> '91600000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'durable local deletion notice was not claimed';
    END IF;
    IF botmem.fail_workspace_device_deletion_notice(
        notice.job_id, notice.device_id, 'api-relay-test', notice.lease_token,
        '2026-07-13T10:09:02Z', '2026-07-13T10:20:00Z'
    ) <> 'pending' THEN
        RAISE EXCEPTION 'offline local deletion notice was not retained for best-effort retry';
    END IF;
    BEGIN
        PERFORM botmem.complete_workspace_deletion(
            '91800000-0000-4000-8000-000000000001',
            'not-the-lifecycle-worker', '99000000-0000-4000-8000-000000000003',
            '2026-07-13T10:10:00Z'
        );
        RAISE EXCEPTION 'API role executed hosted erasure';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$api_relay$;

RESET ROLE;
SET LOCAL ROLE botmem_lifecycle;
DO $billing_blocks_deletion$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'lifecycle-delete-test', '99000000-0000-4000-8000-000000000004',
        '2026-07-13T10:10:00Z', '2026-07-13T10:15:00Z'
    );
    IF claimed.job_id IS NOT NULL THEN
        RAISE EXCEPTION 'deletion was claimable before billing cancellation settled';
    END IF;
    BEGIN
        PERFORM secret_hash FROM botmem.identity_credential;
        RAISE EXCEPTION 'lifecycle role read credential hashes';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$billing_blocks_deletion$;

RESET ROLE;
SET LOCAL ROLE botmem_commerce;
DO $billing_outage_recovery$
DECLARE
    claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_billing_cancellation(
        'commerce-cancel-test', '99000000-0000-4000-8000-000000000005',
        '2026-07-13T10:11:00Z', '2026-07-13T10:12:00Z', 2
    );
    IF claimed.job_id <> '91800000-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'pre-erasure billing cancellation was not durably claimable';
    END IF;
    IF botmem.fail_workspace_billing_cancellation(
        claimed.job_id, 'commerce-cancel-test', claimed.lease_token,
        '2026-07-13T10:11:01Z',
        '2026-07-13T10:12:01Z', 2, 'STRIPE_UNAVAILABLE'
    ) <> 'pending' THEN
        RAISE EXCEPTION 'Stripe outage dead-lettered billing cancellation';
    END IF;
    SELECT * INTO claimed FROM botmem.claim_workspace_billing_cancellation(
        'commerce-cancel-test', '99000000-0000-4000-8000-000000000006',
        '2026-07-13T10:12:01Z', '2026-07-13T10:13:01Z', 2
    );
    IF NOT botmem.confirm_workspace_billing_cancellation(
        claimed.job_id, 'commerce-cancel-test', claimed.lease_token,
        '2026-07-13T10:12:02Z', 'canceled'
    ) THEN
        RAISE EXCEPTION 'billing cancellation did not recover after Stripe outage';
    END IF;
END
$billing_outage_recovery$;

RESET ROLE;
SET LOCAL ROLE botmem_lifecycle;
DO $complete_deletion$
DECLARE
    claimed record;
    blockers record;
    artifact record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_workspace_lifecycle_job(
        'lifecycle-delete-test', '99000000-0000-4000-8000-000000000007',
        '2026-07-13T10:13:00Z', '2026-07-13T10:18:00Z'
    );
    IF claimed.job_id <> '91800000-0000-4000-8000-000000000001' OR
       claimed.kind <> 'deletion' THEN
        RAISE EXCEPTION 'settled deletion job was not claimed by lifecycle role';
    END IF;
    SELECT * INTO blockers FROM botmem.workspace_deletion_blockers(
        claimed.job_id, 'lifecycle-delete-test', claimed.lease_token,
        '2026-07-13T10:13:01Z'
    );
    IF blockers.pending_notices <> 1 OR blockers.billing_state <> 'confirmed' THEN
        RAISE EXCEPTION 'deletion blockers were misreported after billing settlement';
    END IF;
    SELECT * INTO artifact FROM botmem.list_workspace_deletion_artifacts(
        claimed.job_id, 'lifecycle-delete-test', claimed.lease_token,
        '2026-07-13T10:13:01Z'
    );
    IF artifact.artifact_key IS NULL OR NOT botmem.complete_workspace_artifact_purge(artifact.job_id) THEN
        RAISE EXCEPTION 'deletion did not durably purge export metadata first';
    END IF;
    IF NOT botmem.complete_workspace_deletion(
        claimed.job_id, 'lifecycle-delete-test', claimed.lease_token,
        '2026-07-13T10:13:02Z'
    ) THEN
        RAISE EXCEPTION 'hosted deletion did not complete';
    END IF;
END
$complete_deletion$;

RESET ROLE;
DO $post_delete_audit$
BEGIN
    IF EXISTS (
        SELECT 1 FROM botmem.ingest_event_revision
         WHERE tenant_id = '91000000-0000-4000-8000-000000000001'
    ) OR EXISTS (
        SELECT 1 FROM botmem.identity_user
         WHERE tenant_id = '91000000-0000-4000-8000-000000000001'
    ) THEN
        RAISE EXCEPTION 'hosted customer content or identity survived deletion';
    END IF;
    IF (SELECT status FROM botmem.workspace
         WHERE id = '91000000-0000-4000-8000-000000000001') <> 'deleted' THEN
        RAISE EXCEPTION 'workspace was not left as deletion audit metadata';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job
         WHERE id = '91800000-0000-4000-8000-000000000001' AND state = 'completed'
    ) OR NOT EXISTS (
         SELECT 1 FROM botmem.workspace_device_deletion_notice
         WHERE job_id = '91800000-0000-4000-8000-000000000001'
           AND state = 'pending'
    ) THEN
        RAISE EXCEPTION 'deletion audit metadata was not retained';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.workspace_billing_cancellation_request
         WHERE job_id = '91800000-0000-4000-8000-000000000001'
           AND state = 'confirmed' AND stripe_subscription_id IS NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM botmem.workspace_deleted_billing_audit
         WHERE job_id = '91800000-0000-4000-8000-000000000001'
           AND cancellation_state = 'confirmed'
    ) THEN
        RAISE EXCEPTION 'minimal billing cancellation audit did not recover safely';
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.billing_signup
         WHERE tenant_id = '91000000-0000-4000-8000-000000000001'
    ) OR EXISTS (
        SELECT 1 FROM botmem.billing_subscription
         WHERE tenant_id = '91000000-0000-4000-8000-000000000001'
    ) OR EXISTS (
        SELECT 1 FROM botmem.stripe_webhook_event
         WHERE signup_id = '91000000-0000-4000-8000-000000000001'
            OR stripe_subscription_id = 'sub_OutageRecovery123'
            OR stripe_customer_id = 'cus_Lifecycle123'
    ) THEN
        RAISE EXCEPTION 'billing PII or Stripe records survived hosted erasure';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.identity_user
         WHERE tenant_id = '91000000-0000-4000-8000-000000000002'
    ) THEN
        RAISE EXCEPTION 'cross-tenant identity was erased';
    END IF;
END
$post_delete_audit$;

ROLLBACK;
