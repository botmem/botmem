-- Durable, coalescing hosted connector scheduler. Provider payloads and
-- credentials never enter this queue; jobs contain only routing identifiers.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE TABLE botmem.hosted_sync_job (
    id                          uuid        PRIMARY KEY,
    tenant_id                   uuid        NOT NULL,
    account_id                  uuid        NOT NULL,
    connector                   text        NOT NULL,
    state                       text        NOT NULL DEFAULT 'pending',
    request_version             bigint      NOT NULL DEFAULT 1,
    claimed_request_version     bigint,
    attempts                    integer     NOT NULL DEFAULT 0,
    available_at                timestamptz NOT NULL,
    requested_at                timestamptz NOT NULL,
    started_at                  timestamptz,
    finished_at                 timestamptz,
    lease_owner                 text,
    lease_token                 uuid,
    lease_expires_at            timestamptz,
    failure_code                text,
    CONSTRAINT hosted_sync_job_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT hosted_sync_job_account_uq UNIQUE (tenant_id, account_id),
    CONSTRAINT hosted_sync_job_connector_ck CHECK (connector IN ('gmail', 'outlook', 'owntracks')),
    CONSTRAINT hosted_sync_job_state_ck
        CHECK (state IN ('pending', 'running', 'retry_wait', 'completed', 'dead', 'cancelled')),
    CONSTRAINT hosted_sync_job_version_ck CHECK (
        request_version >= 1 AND
        (claimed_request_version IS NULL OR
         claimed_request_version BETWEEN 1 AND request_version)
    ),
    CONSTRAINT hosted_sync_job_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT hosted_sync_job_lease_ck CHECK (
        (state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND
         lease_expires_at IS NOT NULL AND started_at IS NOT NULL AND
         claimed_request_version IS NOT NULL) OR
        (state <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND
         lease_expires_at IS NULL)
    ),
    CONSTRAINT hosted_sync_job_finished_ck CHECK (
        (state IN ('completed', 'dead', 'cancelled') AND finished_at IS NOT NULL) OR
        (state NOT IN ('completed', 'dead', 'cancelled') AND finished_at IS NULL)
    ),
    CONSTRAINT hosted_sync_job_failure_ck CHECK (
        failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 128
    )
);

CREATE INDEX hosted_sync_job_claim_idx
    ON botmem.hosted_sync_job (available_at, requested_at, id)
    WHERE state IN ('pending', 'retry_wait', 'running');

CREATE TABLE botmem.hosted_sync_worker_heartbeat (
    worker_id       text        PRIMARY KEY,
    started_at      timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL,
    CONSTRAINT hosted_sync_worker_id_ck
        CHECK (worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT hosted_sync_worker_time_ck CHECK (last_seen_at >= started_at)
);

ALTER TABLE botmem.hosted_sync_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_sync_job FORCE ROW LEVEL SECURITY;

CREATE POLICY hosted_sync_job_api_tenant_policy ON botmem.hosted_sync_job
    TO botmem_api
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY hosted_sync_job_worker_tenant_policy ON botmem.hosted_sync_job
    TO botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY hosted_sync_job_owner_policy ON botmem.hosted_sync_job
    TO botmem_schema_owner USING (true) WITH CHECK (true);

CREATE FUNCTION botmem.claim_hosted_sync_job(
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
             (job.state IN ('pending', 'retry_wait') AND job.available_at <= requested_now) OR
             (job.state = 'running' AND job.lease_expires_at <= requested_now)
         )
           AND job.attempts < requested_max_attempts
         ORDER BY job.available_at, job.requested_at, job.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    ), claimed AS (
        UPDATE botmem.hosted_sync_job job
           SET state = 'running',
               claimed_request_version = job.request_version,
               attempts = job.attempts + 1,
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

CREATE FUNCTION botmem.hosted_sync_worker_ready(
    requested_now timestamptz,
    requested_max_age_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $ready$
BEGIN
    IF requested_max_age_seconds NOT BETWEEN 1 AND 300 THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM botmem.hosted_sync_worker_heartbeat heartbeat
         WHERE heartbeat.last_seen_at >=
               requested_now - make_interval(secs => requested_max_age_seconds)
    );
END
$ready$;

REVOKE ALL ON FUNCTION botmem.claim_hosted_sync_job(text, uuid, timestamptz, timestamptz, integer)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.hosted_sync_worker_ready(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.claim_hosted_sync_job(text, uuid, timestamptz, timestamptz, integer)
    TO botmem_worker;
GRANT EXECUTE ON FUNCTION botmem.hosted_sync_worker_ready(timestamptz, integer)
    TO botmem_api;

GRANT SELECT, INSERT ON botmem.hosted_sync_job TO botmem_api;
GRANT UPDATE (
    state, request_version, claimed_request_version, attempts, available_at,
    requested_at, started_at, finished_at, lease_owner, lease_token,
    lease_expires_at, failure_code
) ON botmem.hosted_sync_job TO botmem_api;

GRANT SELECT ON botmem.hosted_sync_job TO botmem_worker;
GRANT UPDATE (
    state, attempts, available_at, started_at, finished_at,
    lease_owner, lease_token, lease_expires_at, failure_code
) ON botmem.hosted_sync_job TO botmem_worker;
GRANT SELECT, INSERT, UPDATE ON botmem.hosted_sync_worker_heartbeat TO botmem_worker;

RESET ROLE;
