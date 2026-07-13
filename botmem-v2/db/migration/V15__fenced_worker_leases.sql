SET ROLE botmem_schema_owner;

-- A stable process ID is useful for telemetry, but is not a fencing token. A
-- fresh UUID on every claim prevents an expired process from settling work
-- after another incarnation has reclaimed it with the same process ID.
ALTER TABLE botmem.transactional_outbox ADD COLUMN lease_token uuid;
ALTER TABLE botmem.projection_state ADD COLUMN lease_token uuid;
ALTER TABLE botmem.stripe_webhook_event ADD COLUMN lease_token uuid;
ALTER TABLE botmem.workspace_lifecycle_job ADD COLUMN lease_token uuid;
ALTER TABLE botmem.workspace_device_deletion_notice ADD COLUMN lease_token uuid;
ALTER TABLE botmem.workspace_billing_cancellation_request ADD COLUMN lease_token uuid;

-- No pre-upgrade process owns a token. Release in-flight work for immediate,
-- fenced recovery instead of allowing a legacy static owner to settle it.
UPDATE botmem.transactional_outbox
   SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
       next_attempt_at = LEAST(next_attempt_at, statement_timestamp())
 WHERE state = 'processing';
UPDATE botmem.projection_state
   SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
       output_hash = NULL, last_error_code = NULL, applied_at = NULL,
       updated_at = statement_timestamp()
 WHERE state = 'processing';
UPDATE botmem.stripe_webhook_event
   SET state = 'pending', worker_id = NULL, claimed_at = NULL,
       lease_expires_at = NULL, available_at = LEAST(available_at, statement_timestamp()),
       processed_at = NULL, failure_code = NULL
 WHERE state = 'processing';
UPDATE botmem.workspace_lifecycle_job
   SET state = 'retry', available_at = statement_timestamp(),
       lease_owner = NULL, lease_expires_at = NULL,
       failure_code = 'LEASE_MIGRATED'
 WHERE state = 'running';
UPDATE botmem.workspace_device_deletion_notice
   SET state = 'pending', available_at = LEAST(available_at, statement_timestamp()),
       lease_owner = NULL, lease_expires_at = NULL
 WHERE state = 'delivering';
UPDATE botmem.workspace_billing_cancellation_request
   SET state = 'pending', available_at = LEAST(available_at, statement_timestamp()),
       lease_owner = NULL, lease_expires_at = NULL, failure_code = NULL
 WHERE state = 'processing';

ALTER TABLE botmem.transactional_outbox ADD CONSTRAINT transactional_outbox_token_ck
    CHECK (state <> 'processing' OR lease_token IS NOT NULL);
ALTER TABLE botmem.projection_state ADD CONSTRAINT projection_state_token_ck
    CHECK (state <> 'processing' OR lease_token IS NOT NULL);
ALTER TABLE botmem.stripe_webhook_event ADD CONSTRAINT stripe_webhook_token_ck
    CHECK (state <> 'processing' OR lease_token IS NOT NULL);
ALTER TABLE botmem.workspace_lifecycle_job ADD CONSTRAINT workspace_lifecycle_token_ck
    CHECK (state <> 'running' OR lease_token IS NOT NULL);
ALTER TABLE botmem.workspace_device_deletion_notice
    ADD CONSTRAINT workspace_device_deletion_notice_token_ck
    CHECK (state <> 'delivering' OR lease_token IS NOT NULL);
ALTER TABLE botmem.workspace_billing_cancellation_request
    ADD CONSTRAINT workspace_billing_cancellation_token_ck
    CHECK (state <> 'processing' OR lease_token IS NOT NULL);

GRANT SELECT (lease_token), UPDATE (lease_token)
    ON botmem.transactional_outbox TO botmem_dispatcher;
GRANT UPDATE (lease_token) ON botmem.projection_state TO botmem_worker;
GRANT UPDATE (lease_token) ON botmem.stripe_webhook_event TO botmem_commerce;

CREATE FUNCTION botmem.claim_stripe_webhook(
    p_worker_id text,
    p_lease_token uuid,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz,
    p_max_attempts integer
)
RETURNS TABLE (
    event_id text, event_type text, event_created_at timestamptz,
    object_id text, supported boolean, signup_id uuid,
    stripe_checkout_session_id text, stripe_subscription_id text,
    stripe_customer_id text, attempts integer, lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_webhook_fenced$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_max_attempts NOT BETWEEN 1 AND 100 OR
       p_lease_expires_at <= p_claimed_at THEN
        RAISE EXCEPTION 'commerce reconciler claim rejected' USING ERRCODE = '42501';
    END IF;

    UPDATE botmem.stripe_webhook_event event
       SET state = 'dead_letter', worker_id = NULL, claimed_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, processed_at = p_claimed_at,
           failure_code = 'LEASE_ATTEMPTS_EXHAUSTED'
     WHERE event.state = 'processing'
       AND event.lease_expires_at <= p_claimed_at
       AND event.attempts >= p_max_attempts;

    RETURN QUERY
    WITH candidate AS (
        SELECT queued.id
          FROM botmem.stripe_webhook_event queued
         WHERE (
             (queued.state = 'pending' AND queued.available_at <= p_claimed_at) OR
             (queued.state = 'processing' AND queued.lease_expires_at <= p_claimed_at)
         ) AND queued.attempts < p_max_attempts
         ORDER BY queued.available_at, queued.received_at, queued.id
         FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.stripe_webhook_event queued
       SET state = 'processing', attempts = queued.attempts + 1,
           worker_id = p_worker_id, claimed_at = p_claimed_at,
           lease_token = p_lease_token, lease_expires_at = p_lease_expires_at,
           processed_at = NULL, failure_code = NULL
      FROM candidate
     WHERE queued.id = candidate.id
    RETURNING queued.id, queued.event_type, queued.event_created_at,
              queued.object_id, queued.supported, queued.signup_id,
              queued.stripe_checkout_session_id, queued.stripe_subscription_id,
              queued.stripe_customer_id, queued.attempts, queued.lease_token;
END
$claim_webhook_fenced$;

CREATE FUNCTION botmem.claim_workspace_lifecycle_job(
    p_worker_id text,
    p_lease_token uuid,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid,
    requested_by_user_id uuid, kind text, attempts integer, lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_lifecycle_job_fenced$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_lease_expires_at <= p_claimed_at OR
       p_lease_expires_at > p_claimed_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'lifecycle claim rejected' USING ERRCODE = '42501';
    END IF;

    UPDATE botmem.workspace_lifecycle_job job
       SET state = 'retry', available_at = p_claimed_at + interval '30 seconds',
           attempts = GREATEST(0, job.attempts - 1), lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           failure_code = 'BILLING_CANCELLATION_PENDING'
     WHERE job.kind = 'deletion' AND job.state = 'running'
       AND job.lease_expires_at <= p_claimed_at
       AND NOT EXISTS (
           SELECT 1 FROM botmem.workspace_billing_cancellation_request cancellation
            WHERE cancellation.job_id = job.id
              AND cancellation.state IN ('confirmed', 'not_required')
       );

    UPDATE botmem.workspace_lifecycle_job job
       SET state = 'dead', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, failure_code = 'LEASE_ATTEMPTS_EXHAUSTED'
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
         ) AND candidate_job.attempts < candidate_job.max_attempts
           AND (
               candidate_job.kind <> 'deletion' OR EXISTS (
                   SELECT 1 FROM botmem.workspace_billing_cancellation_request cancellation
                    WHERE cancellation.job_id = candidate_job.id
                      AND cancellation.state IN ('confirmed', 'not_required')
               )
           )
         ORDER BY candidate_job.available_at, candidate_job.requested_at, candidate_job.id
         FOR UPDATE OF candidate_job SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_lifecycle_job claimed
       SET state = 'running', attempts = claimed.attempts + 1,
           lease_owner = p_worker_id, lease_token = p_lease_token,
           lease_expires_at = p_lease_expires_at, failure_code = NULL
      FROM candidate
     WHERE claimed.id = candidate.id
    RETURNING claimed.id, claimed.tenant_id, claimed.workspace_id,
              claimed.requested_by_user_id, claimed.kind, claimed.attempts,
              claimed.lease_token;
END
$claim_lifecycle_job_fenced$;

CREATE FUNCTION botmem.claim_workspace_device_deletion_notice(
    p_relay_id text,
    p_lease_token uuid,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid, device_id uuid,
    attempts integer, lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_deletion_notice_fenced$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       p_relay_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_lease_expires_at <= p_claimed_at OR
       p_lease_expires_at > p_claimed_at + interval '2 minutes' THEN
        RAISE EXCEPTION 'device deletion relay claim rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_device_deletion_notice notice
       SET state = 'unreachable', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, attempted_at = p_claimed_at
     WHERE notice.state = 'delivering' AND notice.lease_expires_at <= p_claimed_at
       AND notice.attempts >= 5;

    RETURN QUERY
    WITH candidate AS (
        SELECT pending.job_id, pending.device_id
          FROM botmem.workspace_device_deletion_notice pending
         WHERE (
             (pending.state = 'pending' AND pending.available_at <= p_claimed_at) OR
             (pending.state = 'delivering' AND pending.lease_expires_at <= p_claimed_at)
         ) AND pending.attempts < 5
         ORDER BY pending.available_at, pending.job_id, pending.device_id
         FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_device_deletion_notice claimed
       SET state = 'delivering', attempts = claimed.attempts + 1,
           lease_owner = p_relay_id, lease_token = p_lease_token,
           lease_expires_at = p_lease_expires_at
      FROM candidate
     WHERE claimed.job_id = candidate.job_id AND claimed.device_id = candidate.device_id
    RETURNING claimed.job_id, claimed.tenant_id, claimed.workspace_id,
              claimed.device_id, claimed.attempts, claimed.lease_token;
END
$claim_deletion_notice_fenced$;

CREATE FUNCTION botmem.claim_workspace_billing_cancellation(
    p_worker_id text,
    p_lease_token uuid,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz,
    p_max_attempts integer
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid,
    stripe_subscription_id text, attempts integer, lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_billing_cancel_fenced$
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
         ) AND pending.stripe_subscription_id IS NOT NULL
         ORDER BY pending.available_at, pending.job_id
         FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_billing_cancellation_request claimed
       SET state = 'processing',
           attempts = CASE WHEN claimed.attempts >= p_max_attempts
                           THEN claimed.attempts ELSE claimed.attempts + 1 END,
           lease_owner = p_worker_id, lease_token = p_lease_token,
           lease_expires_at = p_lease_expires_at, failure_code = NULL
      FROM candidate
     WHERE claimed.job_id = candidate.job_id
    RETURNING claimed.job_id, claimed.tenant_id, claimed.workspace_id,
              claimed.stripe_subscription_id, claimed.attempts, claimed.lease_token;
END
$claim_billing_cancel_fenced$;

-- Token-checking wrappers lock the claim row before delegating to the previous
-- implementation. Legacy signatures remain available only to the schema owner.
CREATE FUNCTION botmem.renew_workspace_lifecycle_lease(
    p_job_id uuid, p_worker_id text, p_lease_token uuid,
    p_now timestamptz, p_lease_expires_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND state = 'running' AND lease_owner = p_worker_id
       AND lease_token = p_lease_token AND lease_expires_at > p_now FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN botmem.renew_workspace_lifecycle_lease(
        p_job_id, p_worker_id, p_now, p_lease_expires_at
    );
END
$fenced$;

CREATE FUNCTION botmem.read_workspace_export_page(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_now timestamptz,
    p_after_account_id uuid, p_after_source_event_id text, p_page_size integer
)
RETURNS TABLE (
    account_id uuid, source_event_id text, connector text, source_revision text,
    kind text, occurred_at timestamptz, observed_at timestamptz,
    payload jsonb, tombstone boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id AND job.kind = 'export' AND job.state = 'running'
       AND job.lease_owner = p_worker_id AND job.lease_token = p_lease_token
       AND job.lease_expires_at > p_now FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle export lease is not active' USING ERRCODE = '55000'; END IF;
    RETURN QUERY SELECT * FROM botmem.read_workspace_export_page(
        p_job_id, p_worker_id, p_now, p_after_account_id, p_after_source_event_id, p_page_size
    );
END
$fenced$;

CREATE FUNCTION botmem.workspace_deletion_blockers(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_now timestamptz
)
RETURNS TABLE (pending_notices integer, billing_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND kind = 'deletion' AND state = 'running'
       AND lease_owner = p_worker_id AND lease_token = p_lease_token
       AND lease_expires_at > p_now FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle deletion blocker read rejected' USING ERRCODE = '42501'; END IF;
    RETURN QUERY SELECT * FROM botmem.workspace_deletion_blockers(p_job_id, p_worker_id, p_now);
END
$fenced$;

CREATE FUNCTION botmem.defer_workspace_deletion(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_now timestamptz,
    p_retry_at timestamptz, p_reason text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed boolean;
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND kind = 'deletion' AND state = 'running'
       AND lease_owner = p_worker_id AND lease_token = p_lease_token
       AND lease_expires_at > p_now FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    changed := botmem.defer_workspace_deletion(p_job_id, p_worker_id, p_now, p_retry_at, p_reason);
    IF changed THEN UPDATE botmem.workspace_lifecycle_job SET lease_token = NULL WHERE id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.list_workspace_deletion_artifacts(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_now timestamptz
)
RETURNS TABLE (job_id uuid, artifact_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND kind = 'deletion' AND state = 'running'
       AND lease_owner = p_worker_id AND lease_token = p_lease_token
       AND lease_expires_at > p_now FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle deletion lease was lost' USING ERRCODE = '55000'; END IF;
    RETURN QUERY SELECT * FROM botmem.list_workspace_deletion_artifacts(p_job_id, p_worker_id, p_now);
END
$fenced$;

CREATE FUNCTION botmem.complete_workspace_export(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_completed_at timestamptz,
    p_artifact_key text, p_artifact_expires_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed boolean;
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND kind = 'export' AND state = 'running'
       AND lease_owner = p_worker_id AND lease_token = p_lease_token
       AND lease_expires_at > p_completed_at FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    changed := botmem.complete_workspace_export(
        p_job_id, p_worker_id, p_completed_at, p_artifact_key, p_artifact_expires_at
    );
    IF changed THEN UPDATE botmem.workspace_lifecycle_job SET lease_token = NULL WHERE id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.authorize_workspace_destruction(
    p_job_id uuid, p_worker_id text, p_lease_token uuid,
    p_now timestamptz, p_lease_expires_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $authorize_destruction$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_lease_expires_at <= p_now OR
       p_lease_expires_at > p_now + interval '15 minutes' THEN
        RAISE EXCEPTION 'workspace destruction authorization rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job job
       SET lease_expires_at = p_lease_expires_at
     WHERE job.id = p_job_id AND job.kind = 'deletion' AND job.state = 'running'
       AND job.lease_owner = p_worker_id AND job.lease_token = p_lease_token
       AND job.lease_expires_at > p_now
       AND EXISTS (
           SELECT 1 FROM botmem.workspace_billing_cancellation_request cancellation
            WHERE cancellation.job_id = job.id
              AND cancellation.state IN ('confirmed', 'not_required')
       );
    RETURN FOUND;
END
$authorize_destruction$;

CREATE FUNCTION botmem.complete_workspace_deletion(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_completed_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed boolean;
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id AND job.kind = 'deletion' AND job.state = 'running'
       AND job.lease_owner = p_worker_id AND job.lease_token = p_lease_token
       AND job.lease_expires_at > p_completed_at
       AND EXISTS (
           SELECT 1 FROM botmem.workspace_billing_cancellation_request cancellation
            WHERE cancellation.job_id = job.id
              AND cancellation.state IN ('confirmed', 'not_required')
       ) FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    changed := botmem.complete_workspace_deletion(p_job_id, p_worker_id, p_completed_at);
    IF changed THEN UPDATE botmem.workspace_lifecycle_job SET lease_token = NULL WHERE id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.fail_workspace_lifecycle_job(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_failed_at timestamptz,
    p_retry_at timestamptz, p_failure_code text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed text;
BEGIN
    PERFORM 1 FROM botmem.workspace_lifecycle_job
     WHERE id = p_job_id AND state = 'running' AND lease_owner = p_worker_id
       AND lease_token = p_lease_token AND lease_expires_at > p_failed_at FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    changed := botmem.fail_workspace_lifecycle_job(
        p_job_id, p_worker_id, p_failed_at, p_retry_at, p_failure_code
    );
    IF changed IS NOT NULL THEN UPDATE botmem.workspace_lifecycle_job SET lease_token = NULL WHERE id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.finish_workspace_device_deletion_notice(
    p_job_id uuid, p_device_id uuid, p_relay_id text, p_lease_token uuid,
    p_state text, p_attempted_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed boolean;
BEGIN
    PERFORM 1 FROM botmem.workspace_device_deletion_notice
     WHERE job_id = p_job_id AND device_id = p_device_id AND state = 'delivering'
       AND lease_owner = p_relay_id AND lease_token = p_lease_token
       AND lease_expires_at > p_attempted_at FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    changed := botmem.finish_workspace_device_deletion_notice(
        p_job_id, p_device_id, p_relay_id, p_state, p_attempted_at
    );
    IF changed THEN UPDATE botmem.workspace_device_deletion_notice SET lease_token = NULL
                     WHERE job_id = p_job_id AND device_id = p_device_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.fail_workspace_device_deletion_notice(
    p_job_id uuid, p_device_id uuid, p_relay_id text, p_lease_token uuid,
    p_failed_at timestamptz, p_retry_at timestamptz
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed text;
BEGIN
    PERFORM 1 FROM botmem.workspace_device_deletion_notice
     WHERE job_id = p_job_id AND device_id = p_device_id AND state = 'delivering'
       AND lease_owner = p_relay_id AND lease_token = p_lease_token
       AND lease_expires_at > p_failed_at FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    changed := botmem.fail_workspace_device_deletion_notice(
        p_job_id, p_device_id, p_relay_id, p_failed_at, p_retry_at
    );
    IF changed IS NOT NULL THEN UPDATE botmem.workspace_device_deletion_notice SET lease_token = NULL
                              WHERE job_id = p_job_id AND device_id = p_device_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.confirm_workspace_billing_cancellation(
    p_job_id uuid, p_worker_id text, p_lease_token uuid,
    p_confirmed_at timestamptz, p_observed_stripe_status text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed boolean;
BEGIN
    PERFORM 1 FROM botmem.workspace_billing_cancellation_request
     WHERE job_id = p_job_id AND state = 'processing' AND lease_owner = p_worker_id
       AND lease_token = p_lease_token AND lease_expires_at > p_confirmed_at FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    changed := botmem.confirm_workspace_billing_cancellation(
        p_job_id, p_worker_id, p_confirmed_at, p_observed_stripe_status
    );
    IF changed THEN UPDATE botmem.workspace_billing_cancellation_request SET lease_token = NULL
                     WHERE job_id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

CREATE FUNCTION botmem.fail_workspace_billing_cancellation(
    p_job_id uuid, p_worker_id text, p_lease_token uuid, p_failed_at timestamptz,
    p_retry_at timestamptz, p_max_attempts integer, p_failure_code text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = botmem, pg_catalog
AS $fenced$
DECLARE changed text;
BEGIN
    PERFORM 1 FROM botmem.workspace_billing_cancellation_request
     WHERE job_id = p_job_id AND state = 'processing' AND lease_owner = p_worker_id
       AND lease_token = p_lease_token AND lease_expires_at > p_failed_at FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    changed := botmem.fail_workspace_billing_cancellation(
        p_job_id, p_worker_id, p_failed_at, p_retry_at, p_max_attempts, p_failure_code
    );
    IF changed IS NOT NULL THEN UPDATE botmem.workspace_billing_cancellation_request SET lease_token = NULL
                              WHERE job_id = p_job_id; END IF;
    RETURN changed;
END
$fenced$;

-- Remove every runtime path that accepts only a reusable process ID.
REVOKE EXECUTE ON FUNCTION botmem.claim_stripe_webhook(text, timestamptz, timestamptz, integer)
    FROM botmem_commerce;
REVOKE EXECUTE ON FUNCTION
    botmem.claim_workspace_lifecycle_job(text, timestamptz, timestamptz),
    botmem.renew_workspace_lifecycle_lease(uuid, text, timestamptz, timestamptz),
    botmem.read_workspace_export_page(uuid, text, timestamptz, uuid, text, integer),
    botmem.workspace_deletion_blockers(uuid, text, timestamptz),
    botmem.defer_workspace_deletion(uuid, text, timestamptz, timestamptz, text),
    botmem.complete_workspace_export(uuid, text, timestamptz, text, timestamptz),
    botmem.list_workspace_deletion_artifacts(uuid, text, timestamptz),
    botmem.complete_workspace_deletion(uuid, text, timestamptz),
    botmem.fail_workspace_lifecycle_job(uuid, text, timestamptz, timestamptz, text)
    FROM botmem_lifecycle;
REVOKE EXECUTE ON FUNCTION
    botmem.claim_workspace_device_deletion_notice(text, timestamptz, timestamptz),
    botmem.finish_workspace_device_deletion_notice(uuid, uuid, text, text, timestamptz),
    botmem.fail_workspace_device_deletion_notice(uuid, uuid, text, timestamptz, timestamptz)
    FROM botmem_api;
REVOKE EXECUTE ON FUNCTION
    botmem.claim_workspace_billing_cancellation(text, timestamptz, timestamptz, integer),
    botmem.confirm_workspace_billing_cancellation(uuid, text, timestamptz, text),
    botmem.fail_workspace_billing_cancellation(uuid, text, timestamptz, timestamptz, integer, text)
    FROM botmem_commerce;

REVOKE ALL ON FUNCTION
    botmem.claim_stripe_webhook(text, uuid, timestamptz, timestamptz, integer),
    botmem.claim_workspace_lifecycle_job(text, uuid, timestamptz, timestamptz),
    botmem.renew_workspace_lifecycle_lease(uuid, text, uuid, timestamptz, timestamptz),
    botmem.read_workspace_export_page(uuid, text, uuid, timestamptz, uuid, text, integer),
    botmem.workspace_deletion_blockers(uuid, text, uuid, timestamptz),
    botmem.defer_workspace_deletion(uuid, text, uuid, timestamptz, timestamptz, text),
    botmem.list_workspace_deletion_artifacts(uuid, text, uuid, timestamptz),
    botmem.complete_workspace_export(uuid, text, uuid, timestamptz, text, timestamptz),
    botmem.authorize_workspace_destruction(uuid, text, uuid, timestamptz, timestamptz),
    botmem.complete_workspace_deletion(uuid, text, uuid, timestamptz),
    botmem.fail_workspace_lifecycle_job(uuid, text, uuid, timestamptz, timestamptz, text),
    botmem.claim_workspace_device_deletion_notice(text, uuid, timestamptz, timestamptz),
    botmem.finish_workspace_device_deletion_notice(uuid, uuid, text, uuid, text, timestamptz),
    botmem.fail_workspace_device_deletion_notice(uuid, uuid, text, uuid, timestamptz, timestamptz),
    botmem.claim_workspace_billing_cancellation(text, uuid, timestamptz, timestamptz, integer),
    botmem.confirm_workspace_billing_cancellation(uuid, text, uuid, timestamptz, text),
    botmem.fail_workspace_billing_cancellation(uuid, text, uuid, timestamptz, timestamptz, integer, text)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    botmem.claim_stripe_webhook(text, uuid, timestamptz, timestamptz, integer)
    TO botmem_commerce;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_lifecycle_job(text, uuid, timestamptz, timestamptz),
    botmem.renew_workspace_lifecycle_lease(uuid, text, uuid, timestamptz, timestamptz),
    botmem.read_workspace_export_page(uuid, text, uuid, timestamptz, uuid, text, integer),
    botmem.workspace_deletion_blockers(uuid, text, uuid, timestamptz),
    botmem.defer_workspace_deletion(uuid, text, uuid, timestamptz, timestamptz, text),
    botmem.list_workspace_deletion_artifacts(uuid, text, uuid, timestamptz),
    botmem.complete_workspace_export(uuid, text, uuid, timestamptz, text, timestamptz),
    botmem.authorize_workspace_destruction(uuid, text, uuid, timestamptz, timestamptz),
    botmem.complete_workspace_deletion(uuid, text, uuid, timestamptz),
    botmem.fail_workspace_lifecycle_job(uuid, text, uuid, timestamptz, timestamptz, text)
    TO botmem_lifecycle;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_device_deletion_notice(text, uuid, timestamptz, timestamptz),
    botmem.finish_workspace_device_deletion_notice(uuid, uuid, text, uuid, text, timestamptz),
    botmem.fail_workspace_device_deletion_notice(uuid, uuid, text, uuid, timestamptz, timestamptz)
    TO botmem_api;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_billing_cancellation(text, uuid, timestamptz, timestamptz, integer),
    botmem.confirm_workspace_billing_cancellation(uuid, text, uuid, timestamptz, text),
    botmem.fail_workspace_billing_cancellation(uuid, text, uuid, timestamptz, timestamptz, integer, text)
    TO botmem_commerce;

RESET ROLE;
