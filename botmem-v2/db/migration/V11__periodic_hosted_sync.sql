-- Successful connector jobs remain visibly completed while their durable
-- available_at timestamp becomes the next incremental-sync deadline. Workers
-- atomically claim due completed rows; no separate in-memory timer exists.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

DROP INDEX botmem.hosted_sync_job_claim_idx;
CREATE INDEX hosted_sync_job_claim_idx
    ON botmem.hosted_sync_job (available_at, requested_at, id)
    WHERE state IN ('pending', 'retry_wait', 'running', 'completed');

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim$
BEGIN
    IF requested_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       requested_lease_expires_at <= requested_now OR
       requested_lease_expires_at > requested_now + interval '1 hour' OR
       requested_max_attempts NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'invalid hosted sync claim policy' USING ERRCODE = '22023';
    END IF;

    UPDATE botmem.hosted_sync_job job
       SET state = 'dead',
           finished_at = requested_now,
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
             (job.state IN ('pending', 'retry_wait', 'completed') AND
              job.available_at <= requested_now) OR
             (job.state = 'running' AND job.lease_expires_at <= requested_now)
         )
           AND (job.state = 'completed' OR job.attempts < requested_max_attempts)
         ORDER BY job.available_at, job.requested_at, job.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    ), claimed AS (
        UPDATE botmem.hosted_sync_job job
           SET state = 'running',
               claimed_request_version = job.request_version,
               attempts = CASE WHEN job.state = 'completed' THEN 1 ELSE job.attempts + 1 END,
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

-- Upgrade safety: every already-connected account receives exactly one durable
-- job even if an older API process crashed between connection commit and enqueue.
INSERT INTO botmem.hosted_sync_job (
    id, tenant_id, account_id, connector, state, request_version, attempts,
    available_at, requested_at
)
SELECT gen_random_uuid(), account.tenant_id, account.id, account.connector,
       'pending', 1, 0, statement_timestamp(), statement_timestamp()
  FROM botmem.connector_account account
 WHERE account.status IN ('ready', 'degraded')
ON CONFLICT (tenant_id, account_id) DO NOTHING;

RESET ROLE;
