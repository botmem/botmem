SET ROLE botmem_schema_owner;

-- Hosted sync already had a random lease token, but its claim function trusted
-- the worker's wall clock. Accept only a bounded duration from the worker and
-- anchor due checks, reclamation, starts, and expiry to PostgreSQL time.
CREATE OR REPLACE FUNCTION botmem.claim_hosted_sync_job(
    requested_worker_id text,
    requested_lease_token uuid,
    requested_now timestamptz,
    requested_lease_expires_at timestamptz,
    requested_max_attempts integer,
    requested_exhausted_retry_seconds integer
)
RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    account_id uuid,
    connector text,
    attempt integer,
    lease_token uuid,
    lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_hosted_sync_fenced$
DECLARE
    lease_duration interval := requested_lease_expires_at - requested_now;
    trusted_now timestamptz;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_worker', 'SET') OR
       requested_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       requested_lease_token IS NULL OR
       lease_duration IS NULL OR lease_duration <= interval '0 seconds' OR
       lease_duration > interval '1 hour' OR
       requested_max_attempts NOT BETWEEN 1 AND 20 OR
       requested_exhausted_retry_seconds NOT BETWEEN 900 AND 604800 THEN
        RAISE EXCEPTION 'invalid hosted sync claim policy' USING ERRCODE = '22023';
    END IF;

    trusted_now := clock_timestamp();
    UPDATE botmem.hosted_sync_job job
       SET state = 'retryable_exhausted',
           available_at = trusted_now +
               make_interval(secs => requested_exhausted_retry_seconds),
           finished_at = NULL,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = 'WORKER_LEASE_EXHAUSTED'
     WHERE job.state = 'running'
       AND job.lease_expires_at <= trusted_now
       AND job.attempts >= requested_max_attempts;

    RETURN QUERY
    WITH candidate AS (
        SELECT job.id
          FROM botmem.hosted_sync_job job
         WHERE (
             (job.state IN (
                 'pending', 'retry_wait', 'retryable_exhausted', 'completed'
              ) AND job.available_at <= trusted_now) OR
             (job.state = 'running' AND job.lease_expires_at <= trusted_now)
         )
           AND (
               job.state IN ('completed', 'retryable_exhausted') OR
               job.attempts < requested_max_attempts
           )
         ORDER BY job.available_at, job.requested_at, job.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    ), claimed AS (
        UPDATE botmem.hosted_sync_job job
           SET state = 'running',
               claimed_request_version = job.request_version,
               attempts = CASE
                   WHEN job.state IN ('completed', 'retryable_exhausted') THEN 1
                   ELSE job.attempts + 1
               END,
               started_at = trusted_now,
               finished_at = NULL,
               lease_owner = requested_worker_id,
               lease_token = requested_lease_token,
               lease_expires_at = trusted_now + lease_duration,
               failure_code = NULL
          FROM candidate
         WHERE job.id = candidate.id
         RETURNING job.id, job.tenant_id, job.account_id, job.connector,
                   job.attempts, job.lease_token, job.lease_expires_at
    )
    SELECT claimed.id, claimed.tenant_id, claimed.account_id, claimed.connector,
           claimed.attempts, claimed.lease_token, claimed.lease_expires_at
      FROM claimed;
END
$claim_hosted_sync_fenced$;

-- Authenticated owners may retry a completed export until its retention
-- deadline. Reading the locator is intentionally side-effect free so a broken
-- connection cannot consume the only download attempt before bytes arrive.
CREATE FUNCTION botmem.read_workspace_export_artifact(
    p_job_id uuid,
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $read_export_artifact$
DECLARE
    result_key text;
BEGIN
    PERFORM botmem.assert_lifecycle_owner(
        p_tenant_id, p_workspace_id, p_user_id, false
    );
    SELECT job.artifact_key
      INTO result_key
      FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id
       AND job.tenant_id = p_tenant_id
       AND job.workspace_id = p_workspace_id
       AND job.requested_by_user_id = p_user_id
       AND job.kind = 'export'
       AND job.state = 'ready'
       AND job.artifact_expires_at > clock_timestamp();
    RETURN result_key;
END
$read_export_artifact$;

-- Keep rolling upgrades safe for an older API replica that still calls the
-- former consume-named function. It now has the same repeatable, DB-clock
-- semantics as the canonical reader and no longer mutates the export row.
CREATE OR REPLACE FUNCTION botmem.consume_workspace_export_artifact(
    p_job_id uuid,
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $consume_export_artifact_compatibility$
DECLARE
    result_key text;
BEGIN
    PERFORM botmem.assert_lifecycle_owner(
        p_tenant_id, p_workspace_id, p_user_id, false
    );
    SELECT job.artifact_key
      INTO result_key
      FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id
       AND job.tenant_id = p_tenant_id
       AND job.workspace_id = p_workspace_id
       AND job.requested_by_user_id = p_user_id
       AND job.kind = 'export'
       AND job.state = 'ready'
       AND job.artifact_expires_at > clock_timestamp();
    RETURN result_key;
END
$consume_export_artifact_compatibility$;

-- The dispatcher remains content blind: this function exposes only workspace
-- IDs that have an active ingest head without a usable projection. It covers
-- the crash window where ingestion committed but no outbox row survived.
CREATE FUNCTION botmem.list_projection_repair_workspaces(
    p_after_workspace_id uuid,
    p_limit integer
)
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $list_projection_repair_workspaces$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_dispatcher', 'SET') OR
       p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'projection repair workspace scan rejected'
            USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT DISTINCT ingest_head.tenant_id
      FROM botmem.ingest_event_head ingest_head
      LEFT JOIN botmem.projection_state projection
        ON projection.tenant_id = ingest_head.tenant_id
       AND projection.account_id = ingest_head.account_id
       AND projection.revision_id = ingest_head.head_revision_id
       AND projection.projection_name = 'hosted_search_v1'
     WHERE (p_after_workspace_id IS NULL OR
            ingest_head.tenant_id > p_after_workspace_id)
       AND (
           projection.revision_id IS NULL OR
           projection.state = 'pending' OR
           projection.state = 'failed' OR
           (projection.state = 'processing' AND
            projection.lease_expires_at <= clock_timestamp())
       )
     ORDER BY ingest_head.tenant_id
     LIMIT p_limit;
END
$list_projection_repair_workspaces$;

REVOKE ALL ON FUNCTION
    botmem.read_workspace_export_artifact(uuid, uuid, uuid, uuid, timestamptz),
    botmem.list_projection_repair_workspaces(uuid, integer)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.read_workspace_export_artifact(uuid, uuid, uuid, uuid, timestamptz)
    TO botmem_api;
GRANT EXECUTE ON FUNCTION
    botmem.list_projection_repair_workspaces(uuid, integer)
    TO botmem_dispatcher;

RESET ROLE;
