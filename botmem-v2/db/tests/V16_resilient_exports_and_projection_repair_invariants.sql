\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_schema_owner;
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash,
    credential_ref, status, aggregate_version
) VALUES (
    'f1610000-0000-4000-8000-000000000001',
    'f1610000-0000-4000-8000-000000000002',
    'gmail', 'oauth2', repeat('6', 64), 'vault:v16:lease', 'ready', 1
);
INSERT INTO botmem.hosted_sync_job (
    id, tenant_id, account_id, connector, state, request_version,
    claimed_request_version, attempts, available_at, requested_at,
    started_at, lease_owner, lease_token, lease_expires_at
) VALUES (
    'f1610000-0000-4000-8000-000000000003',
    'f1610000-0000-4000-8000-000000000002',
    'f1610000-0000-4000-8000-000000000001',
    'gmail', 'running', 1, 1, 1, clock_timestamp(), clock_timestamp(),
    clock_timestamp(), 'v16.current',
    'f1610000-0000-4000-8000-000000000004',
    clock_timestamp() + interval '1 day'
);

SET LOCAL ROLE botmem_worker;
DO $hosted_sync_database_clock$
DECLARE claimed record;
BEGIN
    SELECT * INTO claimed FROM botmem.claim_hosted_sync_job(
        'v16.future-caller', 'f1610000-0000-4000-8000-000000000005',
        '2099-01-01T00:00:00Z', '2099-01-01T00:01:00Z', 8, 900
    );
    IF claimed.id IS NOT NULL THEN
        RAISE EXCEPTION 'future caller clock reclaimed an active hosted sync lease';
    END IF;
END
$hosted_sync_database_clock$;

SET LOCAL ROLE botmem_dispatcher;
SELECT * FROM botmem.list_projection_repair_workspaces(NULL, 10);
DO $dispatcher_boundary$
BEGIN
    BEGIN
        PERFORM botmem.read_workspace_export_artifact(
            'f1600000-0000-4000-8000-000000000001',
            'f1600000-0000-4000-8000-000000000002',
            'f1600000-0000-4000-8000-000000000002',
            'f1600000-0000-4000-8000-000000000003',
            '2026-07-13T10:00:00Z'
        );
        RAISE EXCEPTION 'dispatcher read an owner export locator';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$dispatcher_boundary$;

RESET ROLE;
SET LOCAL ROLE botmem_api;
DO $api_boundary$
BEGIN
    BEGIN
        PERFORM * FROM botmem.list_projection_repair_workspaces(NULL, 10);
        RAISE EXCEPTION 'API enumerated cross-tenant projection repair debt';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$api_boundary$;

ROLLBACK;
