-- Production persistence boundary for hosted connector authorization and secrets.
-- OAuth state is a one-use capability; provider credentials are envelope-encrypted
-- before PostgreSQL sees them and can only be addressed in an owner context.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE FUNCTION botmem.current_connector_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
RETURN NULLIF(current_setting('botmem.connector_account_id', true), '')::uuid;

REVOKE ALL ON FUNCTION botmem.current_connector_account_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.current_connector_account_id() TO botmem_api, botmem_worker;

ALTER TABLE botmem.connector_account
    ADD COLUMN display_label text NOT NULL DEFAULT 'Connected account',
    ADD COLUMN connection_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE botmem.connector_account
    ADD CONSTRAINT connector_account_display_label_ck
        CHECK (length(btrim(display_label)) BETWEEN 1 AND 320),
    ADD CONSTRAINT connector_account_connection_config_ck
        CHECK (
            jsonb_typeof(connection_config) = 'object' AND
            (
                (connector IN ('gmail', 'outlook') AND connection_config = '{}'::jsonb) OR
                (
                    connector = 'owntracks' AND
                    connection_config ? 'endpoint' AND
                    connection_config ? 'allowedPorts' AND
                    connection_config - 'endpoint' - 'allowedPorts' = '{}'::jsonb AND
                    jsonb_typeof(connection_config->'endpoint') = 'string' AND
                    jsonb_typeof(connection_config->'allowedPorts') = 'array'
                )
            )
        );

-- The v2 launch API intentionally exposes one account per hosted connector.
-- Supporting multiple mailboxes later requires an explicit account selector in
-- the public contract, not ambiguous reconnect behaviour.
CREATE UNIQUE INDEX connector_account_one_per_connector_uq
    ON botmem.connector_account (tenant_id, connector);

CREATE TABLE botmem.connector_oauth_state (
    state_digest           bytea       PRIMARY KEY,
    tenant_id              uuid        NOT NULL,
    account_id             uuid        NOT NULL,
    connector              text        NOT NULL,
    sealed_pkce_verifier   text        NOT NULL,
    redirect_uri           text        NOT NULL,
    authority              text,
    scope                  text        NOT NULL,
    created_at             timestamptz NOT NULL,
    expires_at             timestamptz NOT NULL,
    CONSTRAINT connector_oauth_state_owner_uq
        UNIQUE (tenant_id, account_id, connector, state_digest),
    CONSTRAINT connector_oauth_state_digest_ck CHECK (octet_length(state_digest) = 32),
    CONSTRAINT connector_oauth_state_connector_ck CHECK (connector IN ('gmail', 'outlook')),
    CONSTRAINT connector_oauth_state_pkce_ck
        CHECK (length(sealed_pkce_verifier) BETWEEN 32 AND 8192),
    CONSTRAINT connector_oauth_state_redirect_ck
        CHECK (length(redirect_uri) BETWEEN 8 AND 2048),
    CONSTRAINT connector_oauth_state_authority_ck CHECK (
        (connector = 'gmail' AND authority IS NULL) OR
        (connector = 'outlook' AND authority = 'common')
    ),
    CONSTRAINT connector_oauth_state_scope_ck CHECK (length(scope) BETWEEN 1 AND 4096),
    CONSTRAINT connector_oauth_state_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
    )
);

CREATE INDEX connector_oauth_state_expiry_idx ON botmem.connector_oauth_state (expires_at);

CREATE TABLE botmem.connector_credential (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    connector           text        NOT NULL,
    secret_kind         text        NOT NULL,
    key_version         integer     NOT NULL,
    wrap_nonce          bytea       NOT NULL,
    wrapped_key         bytea       NOT NULL,
    wrap_tag            bytea       NOT NULL,
    payload_nonce       bytea       NOT NULL,
    ciphertext          bytea       NOT NULL,
    payload_tag         bytea       NOT NULL,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    CONSTRAINT connector_credential_owner_id_uq UNIQUE (tenant_id, account_id, id),
    CONSTRAINT connector_credential_connector_ck
        CHECK (connector IN ('gmail', 'outlook', 'owntracks')),
    CONSTRAINT connector_credential_kind_ck CHECK (
        (connector = 'gmail' AND secret_kind = 'gmail_oauth') OR
        (connector = 'outlook' AND secret_kind = 'outlook_oauth') OR
        (connector = 'owntracks' AND secret_kind = 'owntracks_basic')
    ),
    CONSTRAINT connector_credential_key_version_ck CHECK (key_version > 0),
    CONSTRAINT connector_credential_crypto_ck CHECK (
        octet_length(wrap_nonce) = 12 AND
        octet_length(wrapped_key) = 32 AND
        octet_length(wrap_tag) = 16 AND
        octet_length(payload_nonce) = 12 AND
        octet_length(payload_tag) = 16 AND
        octet_length(ciphertext) BETWEEN 2 AND 65536
    ),
    CONSTRAINT connector_credential_timestamp_ck CHECK (
        updated_at >= created_at AND
        (revoked_at IS NULL OR revoked_at >= created_at)
    )
);

CREATE INDEX connector_credential_owner_active_idx
    ON botmem.connector_credential (tenant_id, account_id, connector, updated_at DESC)
    WHERE revoked_at IS NULL;

CREATE FUNCTION botmem.enforce_connector_credential_update()
RETURNS trigger
LANGUAGE plpgsql
AS $credential_update$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
       NEW.account_id <> OLD.account_id OR NEW.connector <> OLD.connector OR
       NEW.secret_kind <> OLD.secret_kind OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'connector credential ownership is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'revoked connector credentials are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'connector credential update time cannot move backwards'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$credential_update$;

REVOKE ALL ON FUNCTION botmem.enforce_connector_credential_update() FROM PUBLIC;
CREATE TRIGGER connector_credential_update_invariants
BEFORE UPDATE ON botmem.connector_credential
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_connector_credential_update();

ALTER TABLE botmem.connector_oauth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_oauth_state FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.connector_credential FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_oauth_state_tenant_policy ON botmem.connector_oauth_state
    TO botmem_api
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY connector_oauth_state_owner_policy ON botmem.connector_oauth_state
    TO botmem_schema_owner USING (true) WITH CHECK (true);

CREATE POLICY connector_credential_exact_owner_api_policy ON botmem.connector_credential
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        account_id = botmem.current_connector_account_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        account_id = botmem.current_connector_account_id()
    );
CREATE POLICY connector_credential_exact_owner_worker_policy ON botmem.connector_credential
    TO botmem_worker
    USING (
        tenant_id = botmem.current_tenant_id() AND
        account_id = botmem.current_connector_account_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        account_id = botmem.current_connector_account_id()
    );

CREATE FUNCTION botmem.consume_connector_oauth_state(
    requested_connector text,
    requested_digest_hex text,
    requested_now timestamptz
)
RETURNS TABLE (
    tenant_id uuid,
    account_id uuid,
    connector text,
    sealed_pkce_verifier text,
    redirect_uri text,
    authority text,
    scope text,
    created_at timestamptz,
    expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $consume$
BEGIN
    IF requested_connector NOT IN ('gmail', 'outlook') OR
       requested_digest_hex !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
    RETURN QUERY
    DELETE FROM botmem.connector_oauth_state state
     WHERE state.connector = requested_connector
       AND state.state_digest = decode(requested_digest_hex, 'hex')
       AND state.expires_at > requested_now
     RETURNING state.tenant_id, state.account_id, state.connector,
               state.sealed_pkce_verifier, state.redirect_uri, state.authority,
               state.scope, state.created_at, state.expires_at;
END
$consume$;

REVOKE ALL ON FUNCTION botmem.consume_connector_oauth_state(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.consume_connector_oauth_state(text, text, timestamptz)
    TO botmem_api;

GRANT SELECT, INSERT, DELETE ON botmem.connector_oauth_state TO botmem_api;
GRANT SELECT, INSERT ON botmem.connector_credential TO botmem_api, botmem_worker;
GRANT UPDATE (
    key_version, wrap_nonce, wrapped_key, wrap_tag,
    payload_nonce, ciphertext, payload_tag, updated_at, revoked_at
) ON botmem.connector_credential TO botmem_api, botmem_worker;

GRANT SELECT (display_label, connection_config) ON botmem.connector_account TO botmem_api, botmem_worker;
GRANT UPDATE (
    provider_subject_hash, credential_ref, status, display_label,
    connection_config, aggregate_version, updated_at
) ON botmem.connector_account TO botmem_api;
GRANT UPDATE (state, closed_at, failure_code) ON botmem.connector_sync TO botmem_api;
GRANT INSERT ON botmem.connector_checkpoint TO botmem_api;
GRANT UPDATE (cursor_version, cursor, last_sync_id, last_committed_at)
    ON botmem.connector_checkpoint TO botmem_api;

RESET ROLE;
