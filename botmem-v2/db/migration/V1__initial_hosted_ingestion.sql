-- Botmem v2 starts from a new schema. This migration intentionally does not
-- import, rename, or depend on any v1 table.
DO $preflight$
DECLARE
    required_role text;
    unsafe_role text;
BEGIN
    FOREACH required_role IN ARRAY ARRAY[
        'botmem_schema_owner',
        'botmem_api',
        'botmem_worker',
        'botmem_dispatcher'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required_role) THEN
            RAISE EXCEPTION 'required Botmem role % has not been provisioned', required_role;
        END IF;
    END LOOP;

    SELECT rolname
      INTO unsafe_role
      FROM pg_roles
     WHERE rolname IN ('botmem_api', 'botmem_worker', 'botmem_dispatcher')
       AND (rolsuper OR rolbypassrls)
     LIMIT 1;
    IF unsafe_role IS NOT NULL THEN
        RAISE EXCEPTION 'runtime role % must be NOSUPERUSER NOBYPASSRLS', unsafe_role;
    END IF;

    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;

CREATE SCHEMA IF NOT EXISTS botmem AUTHORIZATION botmem_schema_owner;
REVOKE ALL ON SCHEMA botmem FROM PUBLIC;
SET search_path = botmem, pg_catalog;

CREATE FUNCTION botmem.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
RETURN NULLIF(current_setting('botmem.tenant_id', true), '')::uuid;

REVOKE ALL ON FUNCTION botmem.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.current_tenant_id() TO botmem_api, botmem_worker;

CREATE TABLE botmem.connector_account (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    connector           text        NOT NULL,
    auth_kind           text        NOT NULL,
    provider_subject_hash text      NOT NULL,
    credential_ref      text        NOT NULL,
    status              text        NOT NULL DEFAULT 'disconnected',
    aggregate_version   bigint      NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT connector_account_tenant_id_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT connector_account_provider_subject_uq
        UNIQUE (tenant_id, connector, provider_subject_hash),
    CONSTRAINT connector_account_connector_ck
        CHECK (connector IN ('gmail', 'outlook', 'owntracks')),
    CONSTRAINT connector_account_auth_kind_ck
        CHECK (auth_kind IN ('oauth2', 'basic')),
    CONSTRAINT connector_account_auth_consistency_ck
        CHECK (
            (connector IN ('gmail', 'outlook') AND auth_kind = 'oauth2') OR
            (connector = 'owntracks' AND auth_kind = 'basic')
        ),
    CONSTRAINT connector_account_provider_subject_hash_ck
        CHECK (provider_subject_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT connector_account_credential_ref_ck
        CHECK (length(btrim(credential_ref)) BETWEEN 1 AND 1024),
    CONSTRAINT connector_account_status_ck
        CHECK (status IN ('disconnected', 'ready', 'degraded', 'revoked')),
    CONSTRAINT connector_account_aggregate_version_ck CHECK (aggregate_version >= 0),
    CONSTRAINT connector_account_timestamp_ck CHECK (updated_at >= created_at)
);

CREATE INDEX connector_account_tenant_connector_idx
    ON botmem.connector_account (tenant_id, connector, status);

CREATE TABLE botmem.connector_sync (
    id                          uuid        PRIMARY KEY,
    tenant_id                   uuid        NOT NULL,
    account_id                  uuid        NOT NULL,
    state                       text        NOT NULL DEFAULT 'active',
    aggregate_version_at_claim  bigint      NOT NULL,
    started_at                  timestamptz NOT NULL,
    lease_expires_at            timestamptz NOT NULL,
    closed_at                   timestamptz,
    failure_code                text,
    CONSTRAINT connector_sync_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT connector_sync_tenant_id_account_id_id_uq
        UNIQUE (tenant_id, account_id, id),
    CONSTRAINT connector_sync_state_ck
        CHECK (state IN ('active', 'completed', 'failed', 'abandoned')),
    CONSTRAINT connector_sync_version_ck CHECK (aggregate_version_at_claim >= 0),
    CONSTRAINT connector_sync_lease_ck CHECK (lease_expires_at > started_at),
    CONSTRAINT connector_sync_closure_ck CHECK (
        (state = 'active' AND closed_at IS NULL AND failure_code IS NULL) OR
        (state = 'completed' AND closed_at IS NOT NULL AND failure_code IS NULL) OR
        (state IN ('failed', 'abandoned') AND closed_at IS NOT NULL)
    ),
    CONSTRAINT connector_sync_failure_code_ck
        CHECK (failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX connector_sync_one_active_per_account_uq
    ON botmem.connector_sync (tenant_id, account_id)
    WHERE state = 'active';
CREATE INDEX connector_sync_expired_lease_idx
    ON botmem.connector_sync (lease_expires_at)
    WHERE state = 'active';

CREATE TABLE botmem.connector_checkpoint (
    tenant_id           uuid        NOT NULL,
    account_id          uuid        PRIMARY KEY,
    cursor_version      bigint      NOT NULL DEFAULT 0,
    cursor              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    last_sync_id        uuid,
    last_committed_at   timestamptz,
    CONSTRAINT connector_checkpoint_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT connector_checkpoint_sync_fk
        FOREIGN KEY (tenant_id, account_id, last_sync_id)
        REFERENCES botmem.connector_sync (tenant_id, account_id, id),
    CONSTRAINT connector_checkpoint_cursor_version_ck CHECK (cursor_version >= 0),
    CONSTRAINT connector_checkpoint_cursor_type_ck
        CHECK (jsonb_typeof(cursor) IN ('object', 'array', 'string', 'number', 'boolean', 'null')),
    CONSTRAINT connector_checkpoint_sync_time_ck CHECK (
        (last_sync_id IS NULL AND last_committed_at IS NULL) OR
        (last_sync_id IS NOT NULL AND last_committed_at IS NOT NULL)
    )
);

CREATE TABLE botmem.ingest_event_revision (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    source_event_id     text        NOT NULL,
    source_revision     text        NOT NULL,
    kind                text        NOT NULL,
    occurred_at         timestamptz,
    observed_at         timestamptz NOT NULL,
    content_hash        text        NOT NULL,
    payload             jsonb       NOT NULL,
    tombstone           boolean     NOT NULL DEFAULT false,
    CONSTRAINT ingest_event_revision_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT ingest_event_revision_tenant_account_id_uq
        UNIQUE (tenant_id, account_id, id),
    CONSTRAINT ingest_event_revision_tenant_account_source_id_uq
        UNIQUE (tenant_id, account_id, source_event_id, id),
    CONSTRAINT ingest_event_revision_source_uq
        UNIQUE (account_id, source_event_id, source_revision),
    CONSTRAINT ingest_event_revision_source_event_id_ck
        CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 2048),
    CONSTRAINT ingest_event_revision_source_revision_ck
        CHECK (length(btrim(source_revision)) BETWEEN 1 AND 512),
    CONSTRAINT ingest_event_revision_kind_ck CHECK (kind IN ('email', 'location')),
    CONSTRAINT ingest_event_revision_hash_ck CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ingest_event_revision_payload_ck CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX ingest_event_revision_account_observed_idx
    ON botmem.ingest_event_revision (tenant_id, account_id, observed_at DESC, id);

CREATE TABLE botmem.ingest_event_head (
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    source_event_id     text        NOT NULL,
    head_revision_id    uuid        NOT NULL,
    updated_at          timestamptz NOT NULL,
    PRIMARY KEY (account_id, source_event_id),
    CONSTRAINT ingest_event_head_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT ingest_event_head_revision_fk
        FOREIGN KEY (tenant_id, account_id, source_event_id, head_revision_id)
        REFERENCES botmem.ingest_event_revision (tenant_id, account_id, source_event_id, id),
    CONSTRAINT ingest_event_head_tenant_account_source_uq
        UNIQUE (tenant_id, account_id, source_event_id),
    CONSTRAINT ingest_event_head_source_event_id_ck
        CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 2048)
);

CREATE TABLE botmem.transactional_outbox (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    revision_id         uuid        NOT NULL UNIQUE,
    topic               text        NOT NULL DEFAULT 'ingest.revision.observed.v1',
    payload             jsonb       NOT NULL,
    state               text        NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
    lease_owner         text,
    lease_expires_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    published_at        timestamptz,
    CONSTRAINT transactional_outbox_revision_fk
        FOREIGN KEY (tenant_id, account_id, revision_id)
        REFERENCES botmem.ingest_event_revision (tenant_id, account_id, id),
    CONSTRAINT transactional_outbox_topic_ck
        CHECK (topic = 'ingest.revision.observed.v1'),
    CONSTRAINT transactional_outbox_payload_ck CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT transactional_outbox_state_ck
        CHECK (state IN ('pending', 'processing', 'published', 'dead')),
    CONSTRAINT transactional_outbox_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT transactional_outbox_lease_ck CHECK (
        (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT transactional_outbox_published_ck CHECK (
        (state = 'published' AND published_at IS NOT NULL) OR
        (state <> 'published' AND published_at IS NULL)
    )
);

CREATE INDEX transactional_outbox_dispatch_idx
    ON botmem.transactional_outbox (state, next_attempt_at, created_at)
    WHERE state IN ('pending', 'processing');

CREATE TABLE botmem.projection_state (
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    projection_name     text        NOT NULL,
    revision_id         uuid        NOT NULL,
    state               text        NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    lease_owner         text,
    lease_expires_at    timestamptz,
    output_hash         text,
    last_error_code     text,
    applied_at          timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (projection_name, revision_id),
    CONSTRAINT projection_state_revision_fk
        FOREIGN KEY (tenant_id, account_id, revision_id)
        REFERENCES botmem.ingest_event_revision (tenant_id, account_id, id),
    CONSTRAINT projection_state_projection_name_ck
        CHECK (length(btrim(projection_name)) BETWEEN 1 AND 128),
    CONSTRAINT projection_state_state_ck
        CHECK (state IN ('pending', 'processing', 'applied', 'failed')),
    CONSTRAINT projection_state_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT projection_state_lease_ck CHECK (
        (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT projection_state_applied_ck CHECK (
        (state = 'applied' AND output_hash ~ '^[0-9a-f]{64}$' AND applied_at IS NOT NULL) OR
        (state <> 'applied' AND output_hash IS NULL AND applied_at IS NULL)
    ),
    CONSTRAINT projection_state_error_code_ck
        CHECK (last_error_code IS NULL OR length(btrim(last_error_code)) BETWEEN 1 AND 128)
);

CREATE FUNCTION botmem.reject_immutable_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
    RAISE EXCEPTION 'ingest_event_revision rows are append-only'
        USING ERRCODE = '55000';
END
$immutable$;

REVOKE ALL ON FUNCTION botmem.reject_immutable_revision_mutation() FROM PUBLIC;

CREATE TRIGGER ingest_event_revision_is_immutable
BEFORE UPDATE OR DELETE ON botmem.ingest_event_revision
FOR EACH ROW EXECUTE FUNCTION botmem.reject_immutable_revision_mutation();

ALTER TABLE botmem.connector_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_account FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_sync FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_checkpoint FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.ingest_event_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.ingest_event_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.ingest_event_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.ingest_event_head FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.transactional_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.transactional_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.projection_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.projection_state FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_account_tenant_policy ON botmem.connector_account
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY connector_sync_tenant_policy ON botmem.connector_sync
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY connector_checkpoint_tenant_policy ON botmem.connector_checkpoint
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY ingest_event_revision_tenant_policy ON botmem.ingest_event_revision
    TO botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY ingest_event_head_tenant_policy ON botmem.ingest_event_head
    TO botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY transactional_outbox_tenant_policy ON botmem.transactional_outbox
    TO botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY transactional_outbox_dispatcher_select_policy ON botmem.transactional_outbox
    FOR SELECT TO botmem_dispatcher
    USING (true);
CREATE POLICY transactional_outbox_dispatcher_update_policy ON botmem.transactional_outbox
    FOR UPDATE TO botmem_dispatcher
    USING (true)
    WITH CHECK (true);
CREATE POLICY projection_state_tenant_policy ON botmem.projection_state
    TO botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());

GRANT USAGE ON SCHEMA botmem TO botmem_api, botmem_worker, botmem_dispatcher;

GRANT SELECT, INSERT ON botmem.connector_account TO botmem_api;
GRANT UPDATE (
    credential_ref,
    status,
    updated_at
) ON botmem.connector_account TO botmem_api;
GRANT SELECT ON botmem.connector_sync, botmem.connector_checkpoint TO botmem_api;

GRANT SELECT ON botmem.connector_account TO botmem_worker;
GRANT UPDATE (
    aggregate_version,
    status,
    updated_at
) ON botmem.connector_account TO botmem_worker;
GRANT SELECT, INSERT ON botmem.connector_sync TO botmem_worker;
GRANT UPDATE (
    state,
    lease_expires_at,
    closed_at,
    failure_code
) ON botmem.connector_sync TO botmem_worker;
GRANT SELECT, INSERT ON botmem.connector_checkpoint TO botmem_worker;
GRANT UPDATE (
    cursor_version,
    cursor,
    last_sync_id,
    last_committed_at
) ON botmem.connector_checkpoint TO botmem_worker;
GRANT SELECT, INSERT ON botmem.ingest_event_revision TO botmem_worker;
GRANT SELECT, INSERT ON botmem.ingest_event_head TO botmem_worker;
GRANT UPDATE (
    head_revision_id,
    updated_at
) ON botmem.ingest_event_head TO botmem_worker;
GRANT SELECT, INSERT ON botmem.transactional_outbox TO botmem_worker;
GRANT SELECT, INSERT ON botmem.projection_state TO botmem_worker;
GRANT UPDATE (
    state,
    attempts,
    lease_owner,
    lease_expires_at,
    output_hash,
    last_error_code,
    applied_at,
    updated_at
) ON botmem.projection_state TO botmem_worker;

GRANT SELECT (
    id,
    tenant_id,
    account_id,
    revision_id,
    topic,
    state,
    attempts,
    next_attempt_at,
    lease_owner,
    lease_expires_at,
    created_at,
    published_at
) ON botmem.transactional_outbox TO botmem_dispatcher;
GRANT UPDATE (
    state,
    attempts,
    next_attempt_at,
    lease_owner,
    lease_expires_at,
    published_at
) ON botmem.transactional_outbox TO botmem_dispatcher;

RESET ROLE;
