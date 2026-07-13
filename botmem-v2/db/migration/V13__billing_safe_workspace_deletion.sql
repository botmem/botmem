-- A workspace must never be erased while its remote Stripe subscription can
-- still recur. Cancellation is a durable, indefinitely retried commerce lane;
-- lifecycle claims and the final workspace transition both require settlement.
DO $preflight$
DECLARE
    required_role text;
BEGIN
    FOREACH required_role IN ARRAY ARRAY[
        'botmem_schema_owner', 'botmem_lifecycle', 'botmem_commerce'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required_role) THEN
            RAISE EXCEPTION 'required Botmem role % has not been provisioned', required_role;
        END IF;
    END LOOP;
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

-- Preserve a reason while cancellation is waiting for its next bounded retry.
ALTER TABLE botmem.workspace_billing_cancellation_request
    DROP CONSTRAINT workspace_billing_cancel_failure_ck,
    ADD CONSTRAINT workspace_billing_cancel_failure_ck CHECK (
        (state = 'dead' AND failure_code ~ '^[A-Z0-9_]{1,64}$') OR
        (state = 'pending' AND (
            failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'
        )) OR
        (state NOT IN ('pending', 'dead') AND failure_code IS NULL)
    );

-- Older releases could leave a cancellation dead even though billing remains
-- recurring. Re-enter those rows into the durable retry lane during upgrade.
UPDATE botmem.workspace_billing_cancellation_request
   SET state = 'pending',
       available_at = LEAST(available_at, clock_timestamp()),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE state = 'dead';

-- `not_required` is reserved for the absence of a remote subscription. Even
-- an unpaid or already-canceled provider object is canonically re-read; the
-- worker confirms canceled objects without issuing a second DELETE.
UPDATE botmem.workspace_billing_cancellation_request
   SET state = 'pending',
       available_at = LEAST(available_at, clock_timestamp())
 WHERE state = 'not_required'
   AND stripe_subscription_id IS NOT NULL;

ALTER TABLE botmem.workspace_billing_cancellation_request
    ADD CONSTRAINT workspace_billing_cancel_state_subscription_ck CHECK (
        (state IN ('not_required', 'confirmed') AND stripe_subscription_id IS NULL) OR
        (state IN ('pending', 'processing', 'dead') AND stripe_subscription_id IS NOT NULL)
    );

CREATE FUNCTION botmem.normalize_workspace_billing_cancellation_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = botmem, pg_catalog
AS $normalize_billing_cancel$
BEGIN
    IF NEW.state = 'not_required' AND NEW.stripe_subscription_id IS NOT NULL THEN
        NEW.state := 'pending';
    END IF;
    RETURN NEW;
END
$normalize_billing_cancel$;

CREATE TRIGGER workspace_billing_cancellation_insert_normalize
BEFORE INSERT ON botmem.workspace_billing_cancellation_request
FOR EACH ROW EXECUTE FUNCTION botmem.normalize_workspace_billing_cancellation_insert();

CREATE OR REPLACE FUNCTION botmem.claim_workspace_lifecycle_job(
    p_worker_id text,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid,
    requested_by_user_id uuid, kind text, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_lifecycle_job$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_lease_expires_at <= p_claimed_at OR
       p_lease_expires_at > p_claimed_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'lifecycle claim rejected' USING ERRCODE = '42501';
    END IF;

    -- A pre-upgrade worker may have held a deletion while billing was still
    -- unsettled. Release that lease without spending a lifecycle attempt.
    UPDATE botmem.workspace_lifecycle_job job
       SET state = 'retry',
           available_at = p_claimed_at + interval '30 seconds',
           attempts = GREATEST(0, job.attempts - 1),
           lease_owner = NULL,
           lease_expires_at = NULL,
           failure_code = 'BILLING_CANCELLATION_PENDING'
     WHERE job.kind = 'deletion'
       AND job.state = 'running'
       AND job.lease_expires_at <= p_claimed_at
       AND NOT EXISTS (
           SELECT 1
             FROM botmem.workspace_billing_cancellation_request cancellation
            WHERE cancellation.job_id = job.id
              AND cancellation.state IN ('confirmed', 'not_required')
       );

    UPDATE botmem.workspace_lifecycle_job job
       SET state = 'dead', lease_owner = NULL, lease_expires_at = NULL,
           failure_code = 'LEASE_ATTEMPTS_EXHAUSTED'
     WHERE job.state = 'running' AND job.lease_expires_at <= p_claimed_at
       AND job.attempts >= job.max_attempts;

    RETURN QUERY
    WITH candidate AS (
        SELECT candidate_job.id
          FROM botmem.workspace_lifecycle_job candidate_job
         WHERE (
             (candidate_job.state IN ('queued', 'retry') AND
              candidate_job.available_at <= p_claimed_at) OR
             (candidate_job.state = 'running' AND
              candidate_job.lease_expires_at <= p_claimed_at)
         )
           AND candidate_job.attempts < candidate_job.max_attempts
           AND (
               candidate_job.kind <> 'deletion' OR EXISTS (
                   SELECT 1
                     FROM botmem.workspace_billing_cancellation_request cancellation
                    WHERE cancellation.job_id = candidate_job.id
                      AND cancellation.state IN ('confirmed', 'not_required')
               )
           )
         ORDER BY candidate_job.available_at, candidate_job.requested_at, candidate_job.id
         FOR UPDATE OF candidate_job SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_lifecycle_job claimed
       SET state = 'running', attempts = claimed.attempts + 1,
           lease_owner = p_worker_id, lease_expires_at = p_lease_expires_at,
           failure_code = NULL
      FROM candidate
     WHERE claimed.id = candidate.id
    RETURNING claimed.id, claimed.tenant_id, claimed.workspace_id,
              claimed.requested_by_user_id, claimed.kind, claimed.attempts;
END
$claim_lifecycle_job$;

CREATE FUNCTION botmem.defer_workspace_deletion(
    p_job_id uuid,
    p_worker_id text,
    p_now timestamptz,
    p_retry_at timestamptz,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $defer_deletion$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_retry_at <= p_now OR p_retry_at > p_now + interval '15 minutes' OR
       p_reason NOT IN ('BILLING_CANCELLATION_PENDING', 'BILLING_CANCELLATION_DEAD') THEN
        RAISE EXCEPTION 'lifecycle deletion deferral rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'retry',
           available_at = p_retry_at,
           attempts = GREATEST(0, attempts - 1),
           lease_owner = NULL,
           lease_expires_at = NULL,
           failure_code = p_reason
     WHERE id = p_job_id AND kind = 'deletion' AND state = 'running'
       AND lease_owner = p_worker_id AND lease_expires_at > p_now;
    RETURN FOUND;
END
$defer_deletion$;

CREATE OR REPLACE FUNCTION botmem.claim_workspace_billing_cancellation(
    p_worker_id text,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz,
    p_max_attempts integer
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid,
    stripe_subscription_id text, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_billing_cancel$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_max_attempts NOT BETWEEN 1 AND 20 OR
       p_lease_expires_at <= p_claimed_at OR
       p_lease_expires_at > p_claimed_at + interval '5 minutes' THEN
        RAISE EXCEPTION 'billing cancellation claim rejected' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH candidate AS (
        SELECT pending.job_id
          FROM botmem.workspace_billing_cancellation_request pending
         WHERE (
             (pending.state = 'pending' AND pending.available_at <= p_claimed_at) OR
             (pending.state = 'processing' AND pending.lease_expires_at <= p_claimed_at)
         )
           AND pending.stripe_subscription_id IS NOT NULL
         ORDER BY pending.available_at, pending.job_id
         FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_billing_cancellation_request claimed
       SET state = 'processing',
           attempts = CASE
               WHEN claimed.attempts >= p_max_attempts THEN claimed.attempts
               ELSE claimed.attempts + 1
           END,
           lease_owner = p_worker_id, lease_expires_at = p_lease_expires_at,
           failure_code = NULL
      FROM candidate
     WHERE claimed.job_id = candidate.job_id
    RETURNING claimed.job_id, claimed.tenant_id, claimed.workspace_id,
              claimed.stripe_subscription_id, claimed.attempts;
END
$claim_billing_cancel$;

CREATE OR REPLACE FUNCTION botmem.fail_workspace_billing_cancellation(
    p_job_id uuid,
    p_worker_id text,
    p_failed_at timestamptz,
    p_retry_at timestamptz,
    p_max_attempts integer,
    p_failure_code text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $fail_billing_cancel$
DECLARE
    result_state text;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_retry_at <= p_failed_at OR
       p_retry_at > p_failed_at + interval '1 hour' OR
       p_max_attempts NOT BETWEEN 1 AND 20 OR
       p_failure_code !~ '^[A-Z0-9_]{1,64}$' THEN
        RAISE EXCEPTION 'billing cancellation failure rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_billing_cancellation_request
       SET state = 'pending',
           available_at = p_retry_at,
           lease_owner = NULL,
           lease_expires_at = NULL,
           failure_code = p_failure_code
     WHERE job_id = p_job_id AND state = 'processing' AND lease_owner = p_worker_id
    RETURNING state INTO result_state;
    RETURN result_state;
END
$fail_billing_cancel$;

CREATE OR REPLACE FUNCTION botmem.confirm_workspace_billing_cancellation(
    p_job_id uuid,
    p_worker_id text,
    p_confirmed_at timestamptz,
    p_observed_stripe_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $confirm_billing_cancel$
DECLARE
    cancellation_updated boolean;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_observed_stripe_status <> 'canceled' THEN
        RAISE EXCEPTION 'billing cancellation confirmation rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_billing_cancellation_request
       SET state = 'confirmed',
           confirmed_at = p_confirmed_at,
           stripe_subscription_id = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           failure_code = NULL
     WHERE job_id = p_job_id AND state = 'processing' AND lease_owner = p_worker_id;
    cancellation_updated := FOUND;
    IF cancellation_updated THEN
        UPDATE botmem.workspace_deleted_billing_audit
           SET cancellation_state = 'confirmed'
         WHERE job_id = p_job_id;
    END IF;
    RETURN cancellation_updated;
END
$confirm_billing_cancel$;

-- This trigger is the final database backstop. If an application regression
-- reaches the erase function early, its entire statement (including preceding
-- content deletes) is rolled back atomically at the workspace transition.
CREATE FUNCTION botmem.enforce_settled_billing_before_workspace_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $enforce_settled_billing$
DECLARE
    erase_job_id uuid;
BEGIN
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
        RAISE EXCEPTION 'deleted workspace status is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> 'deleted' OR OLD.status = 'deleted' THEN
        RETURN NEW;
    END IF;
    BEGIN
        erase_job_id := NULLIF(
            current_setting('botmem.lifecycle_erase_job_id', true), ''
        )::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        erase_job_id := NULL;
    END;
    IF erase_job_id IS NULL OR NOT EXISTS (
        SELECT 1
          FROM botmem.workspace_lifecycle_job job
          JOIN botmem.workspace_billing_cancellation_request cancellation
            ON cancellation.job_id = job.id
         WHERE job.id = erase_job_id
           AND job.tenant_id = NEW.tenant_id
           AND job.workspace_id = NEW.id
           AND job.kind = 'deletion'
           AND job.state = 'running'
           AND cancellation.state IN ('confirmed', 'not_required')
    ) THEN
        RAISE EXCEPTION 'workspace billing cancellation must settle before deletion'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$enforce_settled_billing$;

DROP TRIGGER IF EXISTS workspace_billing_settled_before_delete ON botmem.workspace;
CREATE TRIGGER workspace_billing_settled_before_delete
BEFORE UPDATE OF status ON botmem.workspace
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_settled_billing_before_workspace_delete();

REVOKE ALL ON FUNCTION
    botmem.defer_workspace_deletion(uuid, text, timestamptz, timestamptz, text),
    botmem.normalize_workspace_billing_cancellation_insert(),
    botmem.enforce_settled_billing_before_workspace_delete()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.defer_workspace_deletion(uuid, text, timestamptz, timestamptz, text)
    TO botmem_lifecycle;

RESET ROLE;
