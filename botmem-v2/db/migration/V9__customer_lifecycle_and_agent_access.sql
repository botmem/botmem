-- Customer-operated identity, agent access, export, and deletion lifecycle.
-- Runtime authority is split: the API can request and observe exact-owner jobs;
-- only botmem_lifecycle can claim jobs, read exportable hosted content, or erase.
DO $preflight$
DECLARE
    required_role text;
BEGIN
    FOREACH required_role IN ARRAY ARRAY[
        'botmem_schema_owner', 'botmem_api', 'botmem_commerce', 'botmem_lifecycle'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required_role) THEN
            RAISE EXCEPTION 'required Botmem role % has not been provisioned', required_role;
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname IN ('botmem_api', 'botmem_commerce', 'botmem_lifecycle')
           AND (rolsuper OR rolbypassrls OR rolcanlogin)
    ) THEN
        RAISE EXCEPTION 'lifecycle runtime roles must be NOLOGIN, NOSUPERUSER, NOBYPASSRLS';
    END IF;
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

GRANT USAGE ON SCHEMA botmem TO botmem_lifecycle;

-- Launch policy: one active Botmem identity per canonical email globally. This
-- permits email-only login without guessing or exposing a workspace UUID.
CREATE UNIQUE INDEX identity_user_active_email_lookup_global_uq
    ON botmem.identity_user (email_lookup_hash)
    WHERE status = 'active';

ALTER TABLE botmem.workspace DROP CONSTRAINT workspace_status_ck;
ALTER TABLE botmem.workspace ADD CONSTRAINT workspace_status_ck
    CHECK (status IN ('active', 'suspended', 'deleting', 'deleted'));

ALTER TABLE botmem.identity_credential DROP CONSTRAINT identity_credential_revocation_ck;
ALTER TABLE botmem.identity_credential ADD CONSTRAINT identity_credential_revocation_ck CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_at >= created_at AND
     revocation_reason IN (
         'user_revoked', 'rotated', 'membership_revoked',
         'security_event', 'workspace_deleted'
     ))
);

-- Unknown addresses consume the same hashed rate bucket path as known ones.
-- No email, network address, challenge secret, or delivery result is stored.
CREATE TABLE botmem.identity_login_rate_limit (
    bucket_hash         bytea       PRIMARY KEY,
    window_started_at   timestamptz NOT NULL,
    attempts            integer     NOT NULL,
    updated_at          timestamptz NOT NULL,
    CONSTRAINT identity_login_rate_hash_ck CHECK (octet_length(bucket_hash) = 32),
    CONSTRAINT identity_login_rate_attempts_ck CHECK (attempts BETWEEN 1 AND 100000),
    CONSTRAINT identity_login_rate_time_ck CHECK (updated_at >= window_started_at)
);

ALTER TABLE botmem.identity_login_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_login_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_login_rate_owner_policy ON botmem.identity_login_rate_limit
    TO botmem_schema_owner USING (true) WITH CHECK (true);

-- FORCE RLS also applies to the NOLOGIN schema owner. These explicit policies
-- are the auditable authority used only inside the narrow SECURITY DEFINER
-- functions below; runtime roles receive no membership in botmem_schema_owner.
CREATE POLICY identity_user_schema_owner_policy ON botmem.identity_user
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_schema_owner_policy ON botmem.workspace
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_membership_schema_owner_policy ON botmem.workspace_membership
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_credential_schema_owner_policy ON botmem.identity_credential
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_login_challenge_schema_owner_policy ON botmem.identity_login_challenge
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_account_schema_owner_policy ON botmem.connector_account
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_sync_schema_owner_policy ON botmem.connector_sync
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_checkpoint_schema_owner_policy ON botmem.connector_checkpoint
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY ingest_event_revision_schema_owner_policy ON botmem.ingest_event_revision
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY ingest_event_head_schema_owner_policy ON botmem.ingest_event_head
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY transactional_outbox_schema_owner_policy ON botmem.transactional_outbox
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY projection_state_schema_owner_policy ON botmem.projection_state
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY hosted_document_revision_schema_owner_policy ON botmem.hosted_document_revision
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY hosted_document_head_schema_owner_policy ON botmem.hosted_document_head
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY hosted_source_health_schema_owner_policy ON botmem.hosted_source_health
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY device_registry_schema_owner_policy ON botmem.device_registry
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY device_pairing_grant_schema_owner_policy ON botmem.device_pairing_grant
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY device_auth_challenge_schema_owner_policy ON botmem.device_auth_challenge
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY device_session_credential_schema_owner_policy ON botmem.device_session_credential
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_oauth_state_schema_owner_policy ON botmem.connector_oauth_state
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_credential_schema_owner_policy ON botmem.connector_credential
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY hosted_sync_job_schema_owner_policy ON botmem.hosted_sync_job
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY billing_subscription_schema_owner_lifecycle_policy ON botmem.billing_subscription
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY billing_signup_schema_owner_lifecycle_policy ON botmem.billing_signup
    TO botmem_schema_owner USING (true) WITH CHECK (true);

CREATE FUNCTION botmem.consume_identity_login_rate_limit(
    p_bucket_hash bytea,
    p_now timestamptz,
    p_maximum_attempts integer,
    p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $consume_login_rate$
DECLARE
    current_attempts integer;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       octet_length(p_bucket_hash) <> 32 OR
       p_maximum_attempts NOT BETWEEN 1 AND 100000 OR
       p_window_seconds NOT BETWEEN 60 AND 86400 THEN
        RAISE EXCEPTION 'email login rate request rejected' USING ERRCODE = '42501';
    END IF;

    DELETE FROM botmem.identity_login_rate_limit
     WHERE updated_at < p_now - interval '2 days';

    INSERT INTO botmem.identity_login_rate_limit (
        bucket_hash, window_started_at, attempts, updated_at
    ) VALUES (p_bucket_hash, p_now, 1, p_now)
    ON CONFLICT (bucket_hash) DO UPDATE
       SET window_started_at = CASE
               WHEN botmem.identity_login_rate_limit.window_started_at <=
                    p_now - make_interval(secs => p_window_seconds)
               THEN p_now
               ELSE botmem.identity_login_rate_limit.window_started_at
           END,
           attempts = CASE
               WHEN botmem.identity_login_rate_limit.window_started_at <=
                    p_now - make_interval(secs => p_window_seconds)
               THEN 1
               ELSE LEAST(botmem.identity_login_rate_limit.attempts + 1, 100000)
           END,
           updated_at = GREATEST(botmem.identity_login_rate_limit.updated_at, p_now)
    RETURNING attempts INTO current_attempts;

    RETURN current_attempts <= p_maximum_attempts;
END
$consume_login_rate$;

CREATE FUNCTION botmem.begin_identity_login_challenge(
    p_email_lookup_hash bytea,
    p_challenge_id uuid,
    p_secret_hash bytea,
    p_created_at timestamptz,
    p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $begin_email_login$
DECLARE
    selected_tenant_id uuid;
    selected_workspace_id uuid;
    selected_user_id uuid;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       octet_length(p_email_lookup_hash) <> 32 OR
       octet_length(p_secret_hash) <> 32 OR
       p_expires_at <= p_created_at OR
       p_expires_at > p_created_at + interval '1 hour' THEN
        RAISE EXCEPTION 'email login challenge request rejected' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(encode(p_email_lookup_hash, 'hex'), 49210831)
    );

    SELECT identity_user.tenant_id, membership.workspace_id, identity_user.id
      INTO selected_tenant_id, selected_workspace_id, selected_user_id
      FROM botmem.identity_user identity_user
      JOIN botmem.workspace_membership membership
        ON membership.tenant_id = identity_user.tenant_id
       AND membership.user_id = identity_user.id
       AND membership.status = 'active'
      JOIN botmem.workspace workspace
        ON workspace.tenant_id = membership.tenant_id
       AND workspace.id = membership.workspace_id
       AND workspace.status = 'active'
     WHERE identity_user.email_lookup_hash = p_email_lookup_hash
       AND identity_user.status = 'active'
     ORDER BY membership.created_at, membership.workspace_id
     LIMIT 1;

    IF selected_user_id IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.identity_login_challenge challenge
         WHERE challenge.tenant_id = selected_tenant_id
           AND challenge.workspace_id = selected_workspace_id
           AND challenge.user_id = selected_user_id
           AND challenge.consumed_at IS NULL
           AND challenge.cancelled_at IS NULL
           AND challenge.expires_at > p_created_at
           AND challenge.created_at > p_created_at - interval '60 seconds'
    ) THEN
        RETURN false;
    END IF;

    INSERT INTO botmem.identity_login_challenge (
        id, tenant_id, workspace_id, user_id, secret_hash, created_at, expires_at
    ) VALUES (
        p_challenge_id, selected_tenant_id, selected_workspace_id,
        selected_user_id, p_secret_hash, p_created_at, p_expires_at
    );
    RETURN true;
END
$begin_email_login$;

REVOKE ALL ON FUNCTION
    botmem.consume_identity_login_rate_limit(bytea, timestamptz, integer, integer),
    botmem.begin_identity_login_challenge(bytea, uuid, bytea, timestamptz, timestamptz)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.consume_identity_login_rate_limit(bytea, timestamptz, integer, integer),
    botmem.begin_identity_login_challenge(bytea, uuid, bytea, timestamptz, timestamptz)
    TO botmem_api;

-- Safe PAT metadata is readable only through the exact owner RLS context from
-- V4. Secret hashes remain excluded from metadata queries and responses.
GRANT SELECT (token_prefix, label, created_at)
    ON botmem.identity_credential TO botmem_api;

CREATE FUNCTION botmem.revoke_owned_personal_access_token(
    p_actor_credential_id uuid,
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_target_credential_id uuid,
    p_revoked_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $revoke_owned_pat$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       p_tenant_id IS DISTINCT FROM botmem.current_tenant_id() OR
       p_workspace_id IS DISTINCT FROM botmem.current_workspace_id() OR
       p_user_id IS DISTINCT FROM botmem.current_user_id() OR
       NOT EXISTS (
           SELECT 1 FROM botmem.identity_credential actor
            WHERE actor.id = p_actor_credential_id
              AND actor.tenant_id = p_tenant_id
              AND actor.workspace_id = p_workspace_id
              AND actor.user_id = p_user_id
              AND actor.kind = 'browser_session'
              AND actor.revoked_at IS NULL
              AND actor.expires_at > p_revoked_at
       ) THEN
        RAISE EXCEPTION 'browser credential required to revoke PAT' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.identity_credential target
       SET revoked_at = p_revoked_at, revocation_reason = 'user_revoked'
     WHERE target.id = p_target_credential_id
       AND target.tenant_id = p_tenant_id
       AND target.workspace_id = p_workspace_id
       AND target.user_id = p_user_id
       AND target.kind = 'personal_access_token'
       AND target.revoked_at IS NULL;
    RETURN FOUND;
END
$revoke_owned_pat$;
REVOKE ALL ON FUNCTION
    botmem.revoke_owned_personal_access_token(uuid, uuid, uuid, uuid, uuid, timestamptz)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.revoke_owned_personal_access_token(uuid, uuid, uuid, uuid, uuid, timestamptz)
    TO botmem_api;

CREATE TABLE botmem.workspace_lifecycle_job (
    id                      uuid        PRIMARY KEY,
    tenant_id               uuid        NOT NULL,
    workspace_id            uuid        NOT NULL,
    requested_by_user_id    uuid        NOT NULL,
    kind                    text        NOT NULL,
    state                   text        NOT NULL DEFAULT 'queued',
    requested_at            timestamptz NOT NULL,
    available_at            timestamptz NOT NULL,
    attempts                integer     NOT NULL DEFAULT 0,
    max_attempts            integer     NOT NULL DEFAULT 8,
    lease_owner             text,
    lease_expires_at        timestamptz,
    artifact_key            text,
    artifact_expires_at     timestamptz,
    completed_at            timestamptz,
    failure_code            text,
    repair_count            integer     NOT NULL DEFAULT 0,
    last_repaired_at        timestamptz,
    last_repair_reference   text,
    CONSTRAINT workspace_lifecycle_owner_id_uq
        UNIQUE (tenant_id, workspace_id, requested_by_user_id, id),
    CONSTRAINT workspace_lifecycle_kind_ck CHECK (kind IN ('export', 'deletion')),
    CONSTRAINT workspace_lifecycle_state_ck CHECK (
        state IN ('queued', 'running', 'retry', 'ready', 'completed', 'expired', 'dead')
    ),
    CONSTRAINT workspace_lifecycle_attempts_ck CHECK (
        attempts BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 20
    ),
    CONSTRAINT workspace_lifecycle_lease_ck CHECK (
        (state = 'running' AND lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$' AND
         lease_expires_at IS NOT NULL) OR
        (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT workspace_lifecycle_artifact_ck CHECK (
        (kind = 'export' AND state IN ('ready', 'expired') AND
         artifact_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.bme$' AND
         artifact_expires_at > requested_at) OR
        (kind = 'export' AND state NOT IN ('ready', 'expired') AND
         artifact_key IS NULL AND artifact_expires_at IS NULL) OR
        (kind = 'deletion' AND artifact_key IS NULL AND artifact_expires_at IS NULL)
    ),
    CONSTRAINT workspace_lifecycle_completion_ck CHECK (
        (state = 'completed' AND completed_at IS NOT NULL) OR
        (state <> 'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT workspace_lifecycle_failure_ck CHECK (
        (state IN ('retry', 'dead') AND failure_code ~ '^[A-Z0-9_]{1,64}$') OR
        (state NOT IN ('retry', 'dead') AND failure_code IS NULL)
    ),
    CONSTRAINT workspace_lifecycle_repair_ck CHECK (
        (repair_count = 0 AND last_repaired_at IS NULL AND last_repair_reference IS NULL) OR
        (repair_count > 0 AND last_repaired_at >= requested_at AND
         last_repair_reference ~ '^[A-Za-z0-9._:-]{1,64}$')
    )
);

CREATE UNIQUE INDEX workspace_lifecycle_deletion_once_uq
    ON botmem.workspace_lifecycle_job (tenant_id, workspace_id)
    WHERE kind = 'deletion';
CREATE UNIQUE INDEX workspace_lifecycle_export_active_uq
    ON botmem.workspace_lifecycle_job (tenant_id, workspace_id)
    WHERE kind = 'export' AND state IN ('queued', 'running', 'retry', 'ready');
CREATE INDEX workspace_lifecycle_claim_idx
    ON botmem.workspace_lifecycle_job (available_at, requested_at, id)
    WHERE state IN ('queued', 'retry', 'running');
CREATE INDEX workspace_lifecycle_artifact_expiry_idx
    ON botmem.workspace_lifecycle_job (artifact_expires_at, id)
    WHERE kind = 'export' AND state IN ('ready', 'expired');

CREATE TABLE botmem.workspace_device_deletion_notice (
    job_id              uuid        NOT NULL,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    device_id           uuid        NOT NULL,
    state               text        NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    available_at        timestamptz NOT NULL,
    lease_owner         text,
    lease_expires_at    timestamptz,
    attempted_at        timestamptz,
    PRIMARY KEY (job_id, device_id),
    CONSTRAINT workspace_device_deletion_notice_job_fk FOREIGN KEY (job_id)
        REFERENCES botmem.workspace_lifecycle_job (id),
    CONSTRAINT workspace_device_deletion_notice_state_ck
        CHECK (state IN ('pending', 'delivering', 'delivered', 'unreachable')),
    CONSTRAINT workspace_device_deletion_notice_attempts_ck
        CHECK (attempts BETWEEN 0 AND 5),
    CONSTRAINT workspace_device_deletion_notice_lease_ck CHECK (
        (state = 'delivering' AND lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$' AND
         lease_expires_at IS NOT NULL) OR
        (state <> 'delivering' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT workspace_device_deletion_notice_attempt_ck CHECK (
        (state IN ('pending', 'delivering') AND attempted_at IS NULL) OR
        (state IN ('delivered', 'unreachable') AND attempted_at IS NOT NULL)
    )
);

CREATE INDEX workspace_device_deletion_notice_claim_idx
    ON botmem.workspace_device_deletion_notice (available_at, job_id, device_id)
    WHERE state IN ('pending', 'delivering');

CREATE TABLE botmem.workspace_billing_cancellation_request (
    job_id                  uuid        PRIMARY KEY,
    tenant_id               uuid        NOT NULL,
    workspace_id            uuid        NOT NULL,
    stripe_subscription_id  text,
    state                   text        NOT NULL,
    attempts                integer     NOT NULL DEFAULT 0,
    available_at            timestamptz NOT NULL,
    lease_owner             text,
    lease_expires_at        timestamptz,
    confirmed_at            timestamptz,
    failure_code            text,
    CONSTRAINT workspace_billing_cancel_job_fk FOREIGN KEY (job_id)
        REFERENCES botmem.workspace_lifecycle_job (id),
    CONSTRAINT workspace_billing_cancel_state_ck CHECK (
        state IN ('not_required', 'pending', 'processing', 'confirmed', 'dead')
    ),
    CONSTRAINT workspace_billing_cancel_subscription_ck CHECK (
        stripe_subscription_id IS NULL OR
        stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT workspace_billing_cancel_attempts_ck CHECK (attempts BETWEEN 0 AND 20),
    CONSTRAINT workspace_billing_cancel_lease_ck CHECK (
        (state = 'processing' AND lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$' AND
         lease_expires_at IS NOT NULL) OR
        (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT workspace_billing_cancel_completion_ck CHECK (
        (state = 'confirmed' AND confirmed_at IS NOT NULL) OR
        (state <> 'confirmed' AND confirmed_at IS NULL)
    ),
    CONSTRAINT workspace_billing_cancel_failure_ck CHECK (
        (state = 'dead' AND failure_code ~ '^[A-Z0-9_]{1,64}$') OR
        (state <> 'dead' AND failure_code IS NULL)
    )
);

CREATE INDEX workspace_billing_cancellation_claim_idx
    ON botmem.workspace_billing_cancellation_request (available_at, job_id)
    WHERE state IN ('pending', 'processing');

-- Seven-year deletion evidence intentionally contains no email, workspace
-- name, Stripe customer/subscription/checkout identifiers, or event payload.
CREATE TABLE botmem.workspace_deleted_billing_audit (
    job_id                 uuid        PRIMARY KEY,
    had_subscription       boolean     NOT NULL,
    cancellation_state     text        NOT NULL,
    recorded_at            timestamptz NOT NULL,
    retained_until         timestamptz NOT NULL,
    CONSTRAINT workspace_deleted_billing_audit_job_fk FOREIGN KEY (job_id)
        REFERENCES botmem.workspace_lifecycle_job (id),
    CONSTRAINT workspace_deleted_billing_audit_state_ck CHECK (
        cancellation_state IN ('pending', 'processing', 'confirmed', 'not_required')
    ),
    CONSTRAINT workspace_deleted_billing_audit_retention_ck CHECK (
        retained_until = recorded_at + interval '7 years'
    )
);

CREATE TABLE botmem.workspace_lifecycle_worker_heartbeat (
    worker_id       text        PRIMARY KEY,
    started_at      timestamptz NOT NULL,
    last_seen_at    timestamptz NOT NULL,
    CONSTRAINT workspace_lifecycle_worker_id_ck
        CHECK (worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT workspace_lifecycle_worker_time_ck CHECK (last_seen_at >= started_at)
);

ALTER TABLE botmem.workspace_lifecycle_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_lifecycle_job FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_device_deletion_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_device_deletion_notice FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_billing_cancellation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_billing_cancellation_request FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_deleted_billing_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_deleted_billing_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_lifecycle_worker_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_lifecycle_worker_heartbeat FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_lifecycle_job_api_owner_policy ON botmem.workspace_lifecycle_job
    FOR SELECT TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        requested_by_user_id = botmem.current_user_id()
    );
CREATE POLICY workspace_lifecycle_job_worker_policy ON botmem.workspace_lifecycle_job
    TO botmem_lifecycle USING (true) WITH CHECK (true);
CREATE POLICY workspace_lifecycle_job_schema_owner_policy ON botmem.workspace_lifecycle_job
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_device_deletion_notice_worker_policy
    ON botmem.workspace_device_deletion_notice
    TO botmem_lifecycle USING (true) WITH CHECK (true);
CREATE POLICY workspace_device_deletion_notice_schema_owner_policy
    ON botmem.workspace_device_deletion_notice
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_device_deletion_notice_api_owner_policy
    ON botmem.workspace_device_deletion_notice
    FOR SELECT TO botmem_api
    USING (EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job job
         WHERE job.id = workspace_device_deletion_notice.job_id
           AND job.tenant_id = botmem.current_tenant_id()
           AND job.workspace_id = botmem.current_workspace_id()
           AND job.requested_by_user_id = botmem.current_user_id()
    ));
CREATE POLICY workspace_billing_cancellation_lifecycle_policy
    ON botmem.workspace_billing_cancellation_request
    TO botmem_lifecycle USING (true) WITH CHECK (true);
CREATE POLICY workspace_billing_cancellation_schema_owner_policy
    ON botmem.workspace_billing_cancellation_request
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_deleted_billing_audit_schema_owner_policy
    ON botmem.workspace_deleted_billing_audit
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY workspace_lifecycle_heartbeat_worker_policy
    ON botmem.workspace_lifecycle_worker_heartbeat
    TO botmem_lifecycle USING (true) WITH CHECK (true);
CREATE POLICY workspace_lifecycle_heartbeat_schema_owner_policy
    ON botmem.workspace_lifecycle_worker_heartbeat
    TO botmem_schema_owner USING (true) WITH CHECK (true);

GRANT SELECT (
    id, tenant_id, workspace_id, requested_by_user_id, kind, state,
    requested_at, attempts, artifact_expires_at, completed_at, failure_code
) ON botmem.workspace_lifecycle_job TO botmem_api;
GRANT SELECT ON botmem.workspace_device_deletion_notice TO botmem_lifecycle;
GRANT SELECT (job_id, state) ON botmem.workspace_device_deletion_notice TO botmem_api;
GRANT SELECT ON botmem.workspace_billing_cancellation_request TO botmem_lifecycle;
GRANT SELECT, INSERT, UPDATE ON botmem.workspace_lifecycle_worker_heartbeat
    TO botmem_lifecycle;

CREATE FUNCTION botmem.assert_lifecycle_owner(
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_allow_deleting boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $assert_lifecycle_owner$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       p_tenant_id IS DISTINCT FROM botmem.current_tenant_id() OR
       p_workspace_id IS DISTINCT FROM botmem.current_workspace_id() OR
       p_user_id IS DISTINCT FROM botmem.current_user_id() OR
       NOT EXISTS (
           SELECT 1
             FROM botmem.workspace_membership membership
             JOIN botmem.workspace workspace
               ON workspace.tenant_id = membership.tenant_id
              AND workspace.id = membership.workspace_id
            WHERE membership.tenant_id = p_tenant_id
              AND membership.workspace_id = p_workspace_id
              AND membership.user_id = p_user_id
              AND membership.role = 'owner'
              AND membership.status = 'active'
              AND (
                  workspace.status = 'active' OR
                  (p_allow_deleting AND workspace.status = 'deleting')
              )
       ) THEN
        RAISE EXCEPTION 'workspace lifecycle owner check failed' USING ERRCODE = '42501';
    END IF;
END
$assert_lifecycle_owner$;

CREATE FUNCTION botmem.request_workspace_export(
    p_job_id uuid,
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_requested_at timestamptz,
    p_max_attempts integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $request_export$
DECLARE
    result_id uuid;
BEGIN
    PERFORM botmem.assert_lifecycle_owner(
        p_tenant_id, p_workspace_id, p_user_id, false
    );
    IF p_max_attempts NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'invalid export retry policy' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':export', 781241));
    SELECT id INTO result_id
      FROM botmem.workspace_lifecycle_job
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND kind = 'export'
       AND state IN ('queued', 'running', 'retry', 'ready')
     ORDER BY requested_at DESC LIMIT 1;
    IF result_id IS NOT NULL THEN
        RETURN result_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job previous
         WHERE previous.tenant_id = p_tenant_id
           AND previous.workspace_id = p_workspace_id
           AND previous.kind = 'export'
           AND previous.artifact_key IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'previous export artifact must be purged before replacement'
            USING ERRCODE = '55000';
    END IF;
    IF (
        SELECT count(*) FROM botmem.workspace_lifecycle_job recent
         WHERE recent.tenant_id = p_tenant_id
           AND recent.workspace_id = p_workspace_id
           AND recent.kind = 'export'
           AND recent.requested_at > p_requested_at - interval '1 hour'
    ) >= 3 THEN
        RAISE EXCEPTION 'workspace export request rate exceeded'
            USING ERRCODE = '54000';
    END IF;
    INSERT INTO botmem.workspace_lifecycle_job (
        id, tenant_id, workspace_id, requested_by_user_id, kind, state,
        requested_at, available_at, max_attempts
    ) VALUES (
        p_job_id, p_tenant_id, p_workspace_id, p_user_id, 'export', 'queued',
        p_requested_at, p_requested_at, p_max_attempts
    );
    RETURN p_job_id;
END
$request_export$;

CREATE FUNCTION botmem.request_workspace_deletion(
    p_job_id uuid,
    p_tenant_id uuid,
    p_workspace_id uuid,
    p_user_id uuid,
    p_requested_at timestamptz,
    p_max_attempts integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $request_deletion$
DECLARE
    result_id uuid;
BEGIN
    PERFORM botmem.assert_lifecycle_owner(
        p_tenant_id, p_workspace_id, p_user_id, true
    );
    IF p_max_attempts NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'invalid deletion retry policy' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':deletion', 781241));
    SELECT id INTO result_id
      FROM botmem.workspace_lifecycle_job
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND kind = 'deletion'
     LIMIT 1;
    IF result_id IS NOT NULL THEN
        RETURN result_id;
    END IF;

    INSERT INTO botmem.workspace_lifecycle_job (
        id, tenant_id, workspace_id, requested_by_user_id, kind, state,
        requested_at, available_at, max_attempts
    ) VALUES (
        p_job_id, p_tenant_id, p_workspace_id, p_user_id, 'deletion', 'queued',
        p_requested_at, p_requested_at, p_max_attempts
    );
    INSERT INTO botmem.workspace_device_deletion_notice (
        job_id, tenant_id, workspace_id, device_id, available_at
    )
    SELECT p_job_id, registry.tenant_id, registry.workspace_id, registry.id, p_requested_at
      FROM botmem.device_registry registry
     WHERE registry.tenant_id = p_tenant_id
       AND registry.workspace_id = p_workspace_id
       AND registry.status = 'active';
    INSERT INTO botmem.workspace_billing_cancellation_request (
        job_id, tenant_id, workspace_id, stripe_subscription_id, state, available_at
    )
    SELECT p_job_id, p_tenant_id, p_workspace_id,
           subscription.stripe_subscription_id,
           CASE
               WHEN subscription.stripe_subscription_id IS NULL OR
                    subscription.stripe_status IN ('canceled', 'incomplete_expired', 'unpaid')
               THEN 'not_required'
               ELSE 'pending'
           END,
           p_requested_at
      FROM (SELECT 1) seed
      LEFT JOIN botmem.billing_subscription subscription
        ON subscription.tenant_id = p_tenant_id
       AND subscription.workspace_id = p_workspace_id;

    UPDATE botmem.workspace
       SET status = 'deleting', updated_at = GREATEST(updated_at, p_requested_at)
     WHERE tenant_id = p_tenant_id AND id = p_workspace_id
       AND status = 'active';
    UPDATE botmem.identity_credential
       SET revoked_at = p_requested_at, revocation_reason = 'workspace_deleted'
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND revoked_at IS NULL;
    UPDATE botmem.identity_login_challenge
       SET cancelled_at = p_requested_at
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND consumed_at IS NULL AND cancelled_at IS NULL;
    DELETE FROM botmem.connector_oauth_state WHERE tenant_id = p_tenant_id;
    UPDATE botmem.connector_credential
       SET revoked_at = p_requested_at, updated_at = GREATEST(updated_at, p_requested_at)
     WHERE tenant_id = p_tenant_id AND revoked_at IS NULL;
    UPDATE botmem.connector_account
       SET status = 'revoked', aggregate_version = aggregate_version + 1,
           updated_at = GREATEST(updated_at, p_requested_at)
     WHERE tenant_id = p_tenant_id AND status <> 'revoked';
    UPDATE botmem.hosted_sync_job
       SET state = 'cancelled', finished_at = p_requested_at,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           failure_code = 'WORKSPACE_DELETING'
     WHERE tenant_id = p_tenant_id
       AND state IN ('pending', 'running', 'retry_wait');
    UPDATE botmem.connector_sync
       SET state = 'abandoned', closed_at = p_requested_at,
           failure_code = 'WORKSPACE_DELETING'
     WHERE tenant_id = p_tenant_id AND state = 'active';
    DELETE FROM botmem.device_pairing_grant
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id;
    DELETE FROM botmem.device_auth_challenge
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id;
    UPDATE botmem.device_session_credential
       SET revoked_at = p_requested_at, revocation_reason = 'device_revoked'
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND revoked_at IS NULL;
    UPDATE botmem.device_registry
       SET status = 'revoked', credential_version = credential_version + 1,
           updated_at = GREATEST(updated_at, p_requested_at),
           revoked_at = p_requested_at, revocation_reason = 'device_deleted'
     WHERE tenant_id = p_tenant_id AND workspace_id = p_workspace_id
       AND status = 'active';
    RETURN p_job_id;
END
$request_deletion$;

CREATE FUNCTION botmem.consume_workspace_export_artifact(
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
AS $consume_export_artifact$
DECLARE
    result_key text;
BEGIN
    PERFORM botmem.assert_lifecycle_owner(
        p_tenant_id, p_workspace_id, p_user_id, false
    );
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'expired',
           artifact_expires_at = LEAST(artifact_expires_at, p_now + interval '1 hour')
     WHERE id = p_job_id AND tenant_id = p_tenant_id
       AND workspace_id = p_workspace_id
       AND requested_by_user_id = p_user_id
       AND kind = 'export' AND state = 'ready'
       AND artifact_expires_at > p_now
    RETURNING artifact_key INTO result_key;
    RETURN result_key;
END
$consume_export_artifact$;

REVOKE ALL ON FUNCTION
    botmem.assert_lifecycle_owner(uuid, uuid, uuid, boolean),
    botmem.request_workspace_export(uuid, uuid, uuid, uuid, timestamptz, integer),
    botmem.request_workspace_deletion(uuid, uuid, uuid, uuid, timestamptz, integer),
    botmem.consume_workspace_export_artifact(uuid, uuid, uuid, uuid, timestamptz)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.assert_lifecycle_owner(uuid, uuid, uuid, boolean),
    botmem.request_workspace_export(uuid, uuid, uuid, uuid, timestamptz, integer),
    botmem.request_workspace_deletion(uuid, uuid, uuid, uuid, timestamptz, integer),
    botmem.consume_workspace_export_artifact(uuid, uuid, uuid, uuid, timestamptz)
    TO botmem_api;

CREATE FUNCTION botmem.claim_workspace_lifecycle_job(
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
         ORDER BY candidate_job.available_at, candidate_job.requested_at, candidate_job.id
         FOR UPDATE SKIP LOCKED LIMIT 1
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

CREATE FUNCTION botmem.renew_workspace_lifecycle_lease(
    p_job_id uuid,
    p_worker_id text,
    p_now timestamptz,
    p_lease_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $renew_lifecycle_lease$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_lease_expires_at <= p_now OR
       p_lease_expires_at > p_now + interval '15 minutes' THEN
        RAISE EXCEPTION 'lifecycle lease renewal rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET lease_expires_at = p_lease_expires_at
     WHERE id = p_job_id AND state = 'running' AND lease_owner = p_worker_id
       AND lease_expires_at > p_now;
    RETURN FOUND;
END
$renew_lifecycle_lease$;

CREATE FUNCTION botmem.read_workspace_export_page(
    p_job_id uuid,
    p_worker_id text,
    p_now timestamptz,
    p_after_account_id uuid,
    p_after_source_event_id text,
    p_page_size integer
)
RETURNS TABLE (
    account_id uuid, source_event_id text, connector text, source_revision text,
    kind text, occurred_at timestamptz, observed_at timestamptz,
    payload jsonb, tombstone boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $read_export_page$
DECLARE
    selected_tenant_id uuid;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_page_size NOT BETWEEN 1 AND 1000 OR
       ((p_after_account_id IS NULL) <> (p_after_source_event_id IS NULL)) THEN
        RAISE EXCEPTION 'lifecycle export page rejected' USING ERRCODE = '42501';
    END IF;
    SELECT job.tenant_id INTO selected_tenant_id
      FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id AND job.kind = 'export' AND job.state = 'running'
       AND job.lease_owner = p_worker_id AND job.lease_expires_at > p_now;
    IF selected_tenant_id IS NULL THEN
        RAISE EXCEPTION 'lifecycle export lease is not active' USING ERRCODE = '55000';
    END IF;

    RETURN QUERY
    SELECT revision.account_id, revision.source_event_id, account.connector,
           revision.source_revision, revision.kind, revision.occurred_at,
           revision.observed_at, revision.payload, revision.tombstone
      FROM botmem.ingest_event_head head
      JOIN botmem.ingest_event_revision revision
        ON revision.tenant_id = head.tenant_id
       AND revision.account_id = head.account_id
       AND revision.source_event_id = head.source_event_id
       AND revision.id = head.head_revision_id
      JOIN botmem.connector_account account
        ON account.tenant_id = revision.tenant_id
       AND account.id = revision.account_id
     WHERE revision.tenant_id = selected_tenant_id
       AND (
           p_after_account_id IS NULL OR
           (revision.account_id, revision.source_event_id) >
           (p_after_account_id, p_after_source_event_id)
       )
     ORDER BY revision.account_id, revision.source_event_id
     LIMIT p_page_size;
END
$read_export_page$;

CREATE FUNCTION botmem.claim_workspace_device_deletion_notice(
    p_relay_id text,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz
)
RETURNS TABLE (
    job_id uuid, tenant_id uuid, workspace_id uuid, device_id uuid, attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_deletion_notice$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       p_relay_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_lease_expires_at <= p_claimed_at OR
       p_lease_expires_at > p_claimed_at + interval '2 minutes' THEN
        RAISE EXCEPTION 'device deletion relay claim rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_device_deletion_notice notice
       SET state = 'unreachable', lease_owner = NULL, lease_expires_at = NULL,
           attempted_at = p_claimed_at
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
           lease_owner = p_relay_id, lease_expires_at = p_lease_expires_at
      FROM candidate
     WHERE claimed.job_id = candidate.job_id AND claimed.device_id = candidate.device_id
    RETURNING claimed.job_id, claimed.tenant_id, claimed.workspace_id,
              claimed.device_id, claimed.attempts;
END
$claim_deletion_notice$;

CREATE FUNCTION botmem.finish_workspace_device_deletion_notice(
    p_job_id uuid,
    p_device_id uuid,
    p_relay_id text,
    p_state text,
    p_attempted_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $finish_deletion_notice$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       p_state NOT IN ('delivered', 'unreachable') THEN
        RAISE EXCEPTION 'device deletion relay completion rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_device_deletion_notice
       SET state = p_state, attempted_at = p_attempted_at,
           lease_owner = NULL, lease_expires_at = NULL
     WHERE job_id = p_job_id AND device_id = p_device_id
       AND state = 'delivering' AND lease_owner = p_relay_id;
    RETURN FOUND;
END
$finish_deletion_notice$;

CREATE FUNCTION botmem.fail_workspace_device_deletion_notice(
    p_job_id uuid,
    p_device_id uuid,
    p_relay_id text,
    p_failed_at timestamptz,
    p_retry_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $fail_deletion_notice$
DECLARE
    result_state text;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR p_retry_at < p_failed_at THEN
        RAISE EXCEPTION 'device deletion relay retry rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_device_deletion_notice
       SET state = CASE WHEN attempts >= 5 THEN 'unreachable' ELSE 'pending' END,
           available_at = p_retry_at, lease_owner = NULL, lease_expires_at = NULL,
           attempted_at = CASE WHEN attempts >= 5 THEN p_failed_at ELSE NULL END
     WHERE job_id = p_job_id AND device_id = p_device_id
       AND state = 'delivering' AND lease_owner = p_relay_id
    RETURNING state INTO result_state;
    RETURN result_state;
END
$fail_deletion_notice$;

CREATE FUNCTION botmem.workspace_deletion_blockers(
    p_job_id uuid,
    p_worker_id text,
    p_now timestamptz
)
RETURNS TABLE (pending_notices integer, billing_state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $deletion_blockers$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR NOT EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job job
         WHERE job.id = p_job_id AND job.kind = 'deletion' AND job.state = 'running'
           AND job.lease_owner = p_worker_id AND job.lease_expires_at > p_now
    ) THEN
        RAISE EXCEPTION 'lifecycle deletion blocker read rejected' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT count(*) FILTER (WHERE notice.state IN ('pending', 'delivering'))::integer,
           cancellation.state
      FROM botmem.workspace_billing_cancellation_request cancellation
      LEFT JOIN botmem.workspace_device_deletion_notice notice
        ON notice.job_id = cancellation.job_id
     WHERE cancellation.job_id = p_job_id
     GROUP BY cancellation.state;
END
$deletion_blockers$;

CREATE FUNCTION botmem.claim_workspace_billing_cancellation(
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
       p_lease_expires_at > p_claimed_at + interval '15 minutes' THEN
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
         ORDER BY pending.available_at, pending.job_id
         FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE botmem.workspace_billing_cancellation_request claimed
       SET state = 'processing', attempts = (claimed.attempts + 1) % 20,
           lease_owner = p_worker_id, lease_expires_at = p_lease_expires_at,
           failure_code = NULL
      FROM candidate
     WHERE claimed.job_id = candidate.job_id
    RETURNING claimed.job_id, claimed.tenant_id, claimed.workspace_id,
              claimed.stripe_subscription_id, claimed.attempts;
END
$claim_billing_cancel$;

CREATE FUNCTION botmem.confirm_workspace_billing_cancellation(
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
       SET state = 'confirmed', confirmed_at = p_confirmed_at,
           stripe_subscription_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL
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

CREATE FUNCTION botmem.fail_workspace_billing_cancellation(
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
       p_retry_at < p_failed_at OR p_max_attempts NOT BETWEEN 1 AND 20 OR
       p_failure_code !~ '^[A-Z0-9_]{1,64}$' THEN
        RAISE EXCEPTION 'billing cancellation failure rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_billing_cancellation_request
       SET state = 'pending',
           available_at = p_retry_at, lease_owner = NULL, lease_expires_at = NULL,
           failure_code = NULL
     WHERE job_id = p_job_id AND state = 'processing' AND lease_owner = p_worker_id
    RETURNING state INTO result_state;
    RETURN result_state;
END
$fail_billing_cancel$;

CREATE FUNCTION botmem.complete_workspace_export(
    p_job_id uuid,
    p_worker_id text,
    p_completed_at timestamptz,
    p_artifact_key text,
    p_artifact_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $complete_export$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_artifact_expires_at <= p_completed_at THEN
        RAISE EXCEPTION 'lifecycle export completion rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'ready', lease_owner = NULL, lease_expires_at = NULL,
           artifact_key = p_artifact_key, artifact_expires_at = p_artifact_expires_at
     WHERE id = p_job_id AND kind = 'export' AND state = 'running'
       AND lease_owner = p_worker_id;
    RETURN FOUND;
END
$complete_export$;

-- Append-only hosted revisions stay immutable to every ordinary role. The
-- schema owner can bypass only while the narrow deletion function has set a
-- verified lifecycle erase context.
CREATE OR REPLACE FUNCTION botmem.reject_immutable_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
    IF current_user = 'botmem_schema_owner' AND
       NULLIF(current_setting('botmem.lifecycle_erase_job_id', true), '') IS NOT NULL THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'hosted revision rows are append-only'
        USING ERRCODE = '55000';
END
$immutable$;
REVOKE ALL ON FUNCTION botmem.reject_immutable_revision_mutation() FROM PUBLIC;

-- Physical export files are purged by the lifecycle worker before the narrow
-- database erase function is allowed to complete.
CREATE FUNCTION botmem.list_workspace_deletion_artifacts(
    p_job_id uuid,
    p_worker_id text,
    p_now timestamptz
)
RETURNS TABLE (job_id uuid, artifact_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $list_deletion_artifacts$
DECLARE
    selected_tenant_id uuid;
    selected_workspace_id uuid;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles runtime_login
         WHERE runtime_login.rolname = session_user
           AND NOT runtime_login.rolsuper
           AND (
               pg_has_role(session_user, 'botmem_api', 'SET') OR
               pg_has_role(session_user, 'botmem_commerce', 'SET')
           )
    ) THEN
        RAISE EXCEPTION 'lifecycle deletion artifact request rejected'
            USING ERRCODE = '42501';
    END IF;
    SELECT job.tenant_id, job.workspace_id
      INTO selected_tenant_id, selected_workspace_id
      FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id AND job.kind = 'deletion' AND job.state = 'running'
       AND job.lease_owner = p_worker_id AND job.lease_expires_at > p_now;
    IF selected_tenant_id IS NULL THEN
        RAISE EXCEPTION 'lifecycle deletion lease was lost' USING ERRCODE = '55000';
    END IF;
    UPDATE botmem.workspace_lifecycle_job export_job
       SET state = 'expired'
     WHERE export_job.tenant_id = selected_tenant_id
       AND export_job.workspace_id = selected_workspace_id
       AND export_job.kind = 'export' AND export_job.state = 'ready';
    RETURN QUERY
    SELECT export_job.id, export_job.artifact_key
      FROM botmem.workspace_lifecycle_job export_job
     WHERE export_job.tenant_id = selected_tenant_id
       AND export_job.workspace_id = selected_workspace_id
       AND export_job.kind = 'export'
       AND export_job.state = 'expired'
       AND export_job.artifact_key IS NOT NULL
     ORDER BY export_job.requested_at, export_job.id;
END
$list_deletion_artifacts$;

CREATE FUNCTION botmem.complete_workspace_deletion(
    p_job_id uuid,
    p_worker_id text,
    p_completed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $complete_deletion$
DECLARE
    selected_tenant_id uuid;
    selected_workspace_id uuid;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles runtime_login
         WHERE runtime_login.rolname = session_user
           AND NOT runtime_login.rolsuper
           AND (
               pg_has_role(session_user, 'botmem_api', 'SET') OR
               pg_has_role(session_user, 'botmem_commerce', 'SET')
           )
    ) THEN
        RAISE EXCEPTION 'lifecycle deletion completion rejected' USING ERRCODE = '42501';
    END IF;
    SELECT job.tenant_id, job.workspace_id
      INTO selected_tenant_id, selected_workspace_id
      FROM botmem.workspace_lifecycle_job job
     WHERE job.id = p_job_id AND job.kind = 'deletion' AND job.state = 'running'
       AND job.lease_owner = p_worker_id
     FOR UPDATE;
    IF selected_tenant_id IS NULL THEN
        RETURN false;
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.workspace_lifecycle_job export_job
         WHERE export_job.tenant_id = selected_tenant_id
           AND export_job.workspace_id = selected_workspace_id
           AND export_job.kind = 'export'
           AND export_job.artifact_key IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'workspace export artifacts must be purged before deletion'
            USING ERRCODE = '55000';
    END IF;

    PERFORM set_config('botmem.lifecycle_erase_job_id', p_job_id::text, true);
    DELETE FROM botmem.hosted_document_head WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.hosted_source_health WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.hosted_document_revision WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.projection_state WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.transactional_outbox WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.ingest_event_head WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.connector_checkpoint WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.hosted_sync_job WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.connector_sync WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.ingest_event_revision WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.connector_oauth_state WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.connector_credential WHERE tenant_id = selected_tenant_id;

    INSERT INTO botmem.workspace_deleted_billing_audit (
        job_id, had_subscription, cancellation_state, recorded_at, retained_until
    )
    SELECT p_job_id,
           EXISTS (
               SELECT 1 FROM botmem.billing_subscription subscription
                WHERE subscription.tenant_id = selected_tenant_id
                  AND subscription.workspace_id = selected_workspace_id
           ),
           cancellation.state,
           p_completed_at,
           p_completed_at + interval '7 years'
      FROM botmem.workspace_billing_cancellation_request cancellation
     WHERE cancellation.job_id = p_job_id;

    DELETE FROM botmem.stripe_webhook_event event
     WHERE EXISTS (
         SELECT 1
           FROM botmem.billing_signup signup
           LEFT JOIN botmem.billing_subscription subscription
             ON subscription.signup_id = signup.id
          WHERE signup.tenant_id = selected_tenant_id
            AND signup.workspace_id = selected_workspace_id
            AND (
                event.signup_id = signup.id OR
                event.stripe_checkout_session_id = signup.stripe_checkout_session_id OR
                event.stripe_checkout_session_id = subscription.stripe_checkout_session_id OR
                event.stripe_subscription_id = subscription.stripe_subscription_id OR
                event.stripe_customer_id = subscription.stripe_customer_id OR
                event.object_id = signup.stripe_checkout_session_id OR
                event.object_id = subscription.stripe_subscription_id OR
                event.object_id = subscription.stripe_customer_id
            )
     );
    DELETE FROM botmem.billing_subscription
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.billing_signup
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.device_session_credential
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.device_auth_challenge
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.device_pairing_grant
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.device_registry
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.connector_account WHERE tenant_id = selected_tenant_id;
    DELETE FROM botmem.identity_login_challenge
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.identity_credential
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.workspace_membership
     WHERE tenant_id = selected_tenant_id AND workspace_id = selected_workspace_id;
    DELETE FROM botmem.identity_user identity_user
     WHERE identity_user.tenant_id = selected_tenant_id
       AND NOT EXISTS (
           SELECT 1 FROM botmem.workspace_membership membership
            WHERE membership.tenant_id = identity_user.tenant_id
              AND membership.user_id = identity_user.id
       );
    UPDATE botmem.workspace
       SET status = 'deleted', display_name = 'Deleted workspace',
           updated_at = GREATEST(updated_at, p_completed_at)
     WHERE tenant_id = selected_tenant_id AND id = selected_workspace_id;
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           completed_at = p_completed_at
     WHERE id = p_job_id;
    RETURN true;
END
$complete_deletion$;

CREATE FUNCTION botmem.fail_workspace_lifecycle_job(
    p_job_id uuid,
    p_worker_id text,
    p_failed_at timestamptz,
    p_retry_at timestamptz,
    p_failure_code text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $fail_lifecycle_job$
DECLARE
    result_state text;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_failure_code !~ '^[A-Z0-9_]{1,64}$' OR p_retry_at < p_failed_at THEN
        RAISE EXCEPTION 'lifecycle failure update rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retry' END,
           available_at = p_retry_at, lease_owner = NULL, lease_expires_at = NULL,
           failure_code = p_failure_code
     WHERE id = p_job_id AND state = 'running' AND lease_owner = p_worker_id
    RETURNING state INTO result_state;
    RETURN result_state;
END
$fail_lifecycle_job$;

CREATE FUNCTION botmem.repair_workspace_lifecycle_job(
    p_job_id uuid,
    p_repaired_at timestamptz,
    p_repair_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $repair_lifecycle_job$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_repair_reference !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
        RAISE EXCEPTION 'lifecycle repair rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'retry', attempts = 0, available_at = p_repaired_at,
           failure_code = 'OPERATOR_REPAIR', repair_count = repair_count + 1,
           last_repaired_at = p_repaired_at,
           last_repair_reference = p_repair_reference
     WHERE id = p_job_id AND state = 'dead';
    RETURN FOUND;
END
$repair_lifecycle_job$;

CREATE FUNCTION botmem.list_expired_workspace_artifacts(
    p_now timestamptz,
    p_limit integer
)
RETURNS TABLE (job_id uuid, artifact_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $list_expired_artifacts$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'lifecycle artifact expiry rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET state = 'expired'
     WHERE kind = 'export' AND state = 'ready' AND artifact_expires_at <= p_now;
    RETURN QUERY
    SELECT job.id, job.artifact_key
     FROM botmem.workspace_lifecycle_job job
     WHERE job.kind = 'export' AND job.state = 'expired'
       AND job.artifact_key IS NOT NULL
       AND job.artifact_expires_at <= p_now
     ORDER BY job.artifact_expires_at, job.id LIMIT p_limit;
END
$list_expired_artifacts$;

CREATE FUNCTION botmem.purge_expired_workspace_deleted_billing_audit(
    p_now timestamptz,
    p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $purge_billing_audit$
DECLARE
    deleted_count integer;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_limit NOT BETWEEN 1 AND 1000 OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles runtime_login
         WHERE runtime_login.rolname = session_user
           AND NOT runtime_login.rolsuper
           AND (
               pg_has_role(session_user, 'botmem_api', 'SET') OR
               pg_has_role(session_user, 'botmem_commerce', 'SET')
           )
    ) THEN
        RAISE EXCEPTION 'billing audit retention purge rejected' USING ERRCODE = '42501';
    END IF;
    WITH expired AS (
        SELECT audit.job_id
          FROM botmem.workspace_deleted_billing_audit audit
         WHERE audit.retained_until <= p_now
         ORDER BY audit.retained_until, audit.job_id
         FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM botmem.workspace_deleted_billing_audit audit
     USING expired
     WHERE audit.job_id = expired.job_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END
$purge_billing_audit$;

CREATE FUNCTION botmem.complete_workspace_artifact_purge(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $complete_artifact_purge$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') THEN
        RAISE EXCEPTION 'lifecycle artifact purge rejected' USING ERRCODE = '42501';
    END IF;
    UPDATE botmem.workspace_lifecycle_job
       SET artifact_key = NULL, artifact_expires_at = NULL
     WHERE id = p_job_id AND kind = 'export' AND state = 'expired';
    RETURN FOUND;
END
$complete_artifact_purge$;

-- Expired exports may clear their physical locator after the artifact is
-- deleted; ready exports always retain one.
ALTER TABLE botmem.workspace_lifecycle_job DROP CONSTRAINT workspace_lifecycle_artifact_ck;
ALTER TABLE botmem.workspace_lifecycle_job ADD CONSTRAINT workspace_lifecycle_artifact_ck CHECK (
    (kind = 'export' AND state = 'ready' AND
     artifact_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.bme$' AND
     artifact_expires_at > requested_at) OR
    (kind = 'export' AND state = 'expired' AND (
        (artifact_key IS NULL AND artifact_expires_at IS NULL) OR
        (artifact_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.bme$' AND
         artifact_expires_at > requested_at)
    )) OR
    (kind = 'export' AND state NOT IN ('ready', 'expired') AND
     artifact_key IS NULL AND artifact_expires_at IS NULL) OR
    (kind = 'deletion' AND artifact_key IS NULL AND artifact_expires_at IS NULL)
);

CREATE FUNCTION botmem.heartbeat_workspace_lifecycle_worker(
    p_worker_id text,
    p_started_at timestamptz,
    p_seen_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $heartbeat_lifecycle_worker$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR p_seen_at < p_started_at THEN
        RAISE EXCEPTION 'lifecycle worker heartbeat rejected' USING ERRCODE = '42501';
    END IF;
    INSERT INTO botmem.workspace_lifecycle_worker_heartbeat (
        worker_id, started_at, last_seen_at
    ) VALUES (p_worker_id, p_started_at, p_seen_at)
    ON CONFLICT (worker_id) DO UPDATE
       SET started_at = LEAST(
               botmem.workspace_lifecycle_worker_heartbeat.started_at,
               EXCLUDED.started_at
           ),
           last_seen_at = GREATEST(
               botmem.workspace_lifecycle_worker_heartbeat.last_seen_at,
               EXCLUDED.last_seen_at
           );
END
$heartbeat_lifecycle_worker$;

CREATE FUNCTION botmem.workspace_lifecycle_worker_ready(
    p_now timestamptz,
    p_maximum_age_seconds integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = botmem, pg_catalog
RETURN p_maximum_age_seconds BETWEEN 1 AND 3600 AND EXISTS (
    SELECT 1 FROM botmem.workspace_lifecycle_worker_heartbeat heartbeat
     WHERE heartbeat.last_seen_at >=
           p_now - make_interval(secs => p_maximum_age_seconds)
       AND heartbeat.last_seen_at <= p_now + interval '30 seconds'
);

REVOKE ALL ON FUNCTION
    botmem.claim_workspace_lifecycle_job(text, timestamptz, timestamptz),
    botmem.renew_workspace_lifecycle_lease(uuid, text, timestamptz, timestamptz),
    botmem.read_workspace_export_page(uuid, text, timestamptz, uuid, text, integer),
    botmem.claim_workspace_device_deletion_notice(text, timestamptz, timestamptz),
    botmem.finish_workspace_device_deletion_notice(uuid, uuid, text, text, timestamptz),
    botmem.fail_workspace_device_deletion_notice(uuid, uuid, text, timestamptz, timestamptz),
    botmem.workspace_deletion_blockers(uuid, text, timestamptz),
    botmem.claim_workspace_billing_cancellation(text, timestamptz, timestamptz, integer),
    botmem.confirm_workspace_billing_cancellation(uuid, text, timestamptz, text),
    botmem.fail_workspace_billing_cancellation(uuid, text, timestamptz, timestamptz, integer, text),
    botmem.complete_workspace_export(uuid, text, timestamptz, text, timestamptz),
    botmem.list_workspace_deletion_artifacts(uuid, text, timestamptz),
    botmem.complete_workspace_deletion(uuid, text, timestamptz),
    botmem.fail_workspace_lifecycle_job(uuid, text, timestamptz, timestamptz, text),
    botmem.repair_workspace_lifecycle_job(uuid, timestamptz, text),
    botmem.list_expired_workspace_artifacts(timestamptz, integer),
    botmem.purge_expired_workspace_deleted_billing_audit(timestamptz, integer),
    botmem.complete_workspace_artifact_purge(uuid),
    botmem.heartbeat_workspace_lifecycle_worker(text, timestamptz, timestamptz),
    botmem.workspace_lifecycle_worker_ready(timestamptz, integer)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_lifecycle_job(text, timestamptz, timestamptz),
    botmem.renew_workspace_lifecycle_lease(uuid, text, timestamptz, timestamptz),
    botmem.read_workspace_export_page(uuid, text, timestamptz, uuid, text, integer),
    botmem.workspace_deletion_blockers(uuid, text, timestamptz),
    botmem.complete_workspace_export(uuid, text, timestamptz, text, timestamptz),
    botmem.list_workspace_deletion_artifacts(uuid, text, timestamptz),
    botmem.complete_workspace_deletion(uuid, text, timestamptz),
    botmem.fail_workspace_lifecycle_job(uuid, text, timestamptz, timestamptz, text),
    botmem.repair_workspace_lifecycle_job(uuid, timestamptz, text),
    botmem.list_expired_workspace_artifacts(timestamptz, integer),
    botmem.purge_expired_workspace_deleted_billing_audit(timestamptz, integer),
    botmem.complete_workspace_artifact_purge(uuid),
    botmem.heartbeat_workspace_lifecycle_worker(text, timestamptz, timestamptz)
    TO botmem_lifecycle;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_device_deletion_notice(text, timestamptz, timestamptz),
    botmem.finish_workspace_device_deletion_notice(uuid, uuid, text, text, timestamptz),
    botmem.fail_workspace_device_deletion_notice(uuid, uuid, text, timestamptz, timestamptz)
    TO botmem_api;
GRANT EXECUTE ON FUNCTION
    botmem.claim_workspace_billing_cancellation(text, timestamptz, timestamptz, integer),
    botmem.confirm_workspace_billing_cancellation(uuid, text, timestamptz, text),
    botmem.fail_workspace_billing_cancellation(uuid, text, timestamptz, timestamptz, integer, text)
    TO botmem_commerce;
GRANT EXECUTE ON FUNCTION botmem.workspace_lifecycle_worker_ready(timestamptz, integer)
    TO botmem_api, botmem_lifecycle;

RESET ROLE;
