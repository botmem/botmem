-- Retryable connector failures must not strand a hosted account forever after
-- the normal short retry budget is exhausted. A durable exhausted state waits
-- for a bounded long cooldown and then starts one fresh attempt cycle. Dead and
-- cancelled rows remain terminal unless a user explicitly enqueues new work.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

ALTER TABLE botmem.hosted_sync_job
    DROP CONSTRAINT hosted_sync_job_state_ck,
    ADD CONSTRAINT hosted_sync_job_state_ck CHECK (
        state IN (
            'pending', 'running', 'retry_wait', 'retryable_exhausted',
            'completed', 'dead', 'cancelled'
        )
    );

DROP INDEX botmem.hosted_sync_job_claim_idx;
CREATE INDEX hosted_sync_job_claim_idx
    ON botmem.hosted_sync_job (available_at, requested_at, id)
    WHERE state IN (
        'pending', 'retry_wait', 'retryable_exhausted', 'running', 'completed'
    );

CREATE FUNCTION botmem.claim_hosted_sync_job(
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
AS $claim$
BEGIN
    IF requested_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       requested_lease_expires_at <= requested_now OR
       requested_lease_expires_at > requested_now + interval '1 hour' OR
       requested_max_attempts NOT BETWEEN 1 AND 20 OR
       requested_exhausted_retry_seconds NOT BETWEEN 900 AND 604800 THEN
        RAISE EXCEPTION 'invalid hosted sync claim policy' USING ERRCODE = '22023';
    END IF;

    -- A worker crash is operationally retryable. Once normal crash recovery
    -- attempts are exhausted, retain the last reason and schedule a fresh probe
    -- rather than silently turning the account into a permanently dead job.
    UPDATE botmem.hosted_sync_job job
       SET state = 'retryable_exhausted',
           available_at = requested_now +
               make_interval(secs => requested_exhausted_retry_seconds),
           finished_at = NULL,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = 'WORKER_LEASE_EXHAUSTED'
     WHERE job.state = 'running'
       AND job.lease_expires_at <= requested_now
       AND job.attempts >= requested_max_attempts;

    RETURN QUERY
    WITH candidate AS (
        SELECT job.id
          FROM botmem.hosted_sync_job job
         WHERE (
             (job.state IN (
                 'pending', 'retry_wait', 'retryable_exhausted', 'completed'
              ) AND job.available_at <= requested_now) OR
             (job.state = 'running' AND job.lease_expires_at <= requested_now)
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
               started_at = requested_now,
               finished_at = NULL,
               lease_owner = requested_worker_id,
               lease_token = requested_lease_token,
               lease_expires_at = requested_lease_expires_at,
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
$claim$;

-- Keep the pre-V12 signature for operational tools and prior invariant tests.
-- Production workers use the explicit six-argument policy boundary.
CREATE OR REPLACE FUNCTION botmem.claim_hosted_sync_job(
    requested_worker_id text,
    requested_lease_token uuid,
    requested_now timestamptz,
    requested_lease_expires_at timestamptz,
    requested_max_attempts integer
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $compatibility$
    SELECT * FROM botmem.claim_hosted_sync_job(
        requested_worker_id,
        requested_lease_token,
        requested_now,
        requested_lease_expires_at,
        requested_max_attempts,
        21600
    )
$compatibility$;

REVOKE ALL ON FUNCTION botmem.claim_hosted_sync_job(
    text, uuid, timestamptz, timestamptz, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.claim_hosted_sync_job(
    text, uuid, timestamptz, timestamptz, integer, integer
) TO botmem_worker;

RESET ROLE;
