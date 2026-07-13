-- Botmem v2 workspace identity and opaque credentials.
-- Login verification/delivery is deliberately external; this schema stores no
-- passwords, plaintext sessions, personal access tokens, or magic links.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_identity_admin') THEN
        RAISE EXCEPTION 'required Botmem role botmem_identity_admin has not been provisioned';
    END IF;
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE FUNCTION botmem.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
RETURN NULLIF(current_setting('botmem.user_id', true), '')::uuid;

CREATE FUNCTION botmem.current_credential_hash()
RETURNS bytea
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $credential_hash$
DECLARE
    value text := current_setting('botmem.credential_hash', true);
BEGIN
    IF value IS NULL OR value !~ '^[0-9a-f]{64}$' THEN
        RETURN NULL;
    END IF;
    RETURN decode(value, 'hex');
END
$credential_hash$;

CREATE FUNCTION botmem.current_login_email_hash()
RETURNS bytea
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $login_email_hash$
DECLARE
    value text := current_setting('botmem.login_email_hash', true);
BEGIN
    IF value IS NULL OR value !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
    RETURN decode(value, 'hex');
END
$login_email_hash$;

CREATE FUNCTION botmem.current_login_challenge_hash()
RETURNS bytea
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $login_challenge_hash$
DECLARE
    value text := current_setting('botmem.login_challenge_hash', true);
BEGIN
    IF value IS NULL OR value !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
    RETURN decode(value, 'hex');
END
$login_challenge_hash$;

REVOKE ALL ON FUNCTION botmem.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.current_credential_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.current_login_email_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.current_login_challenge_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.current_user_id(),
    botmem.current_credential_hash(),
    botmem.current_login_email_hash(),
    botmem.current_login_challenge_hash()
    TO botmem_api;

CREATE TABLE botmem.identity_user (
    id              uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL,
    email           text        NOT NULL,
    email_lookup_hash bytea     NOT NULL,
    status          text        NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    CONSTRAINT identity_user_tenant_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT identity_user_email_uq UNIQUE (tenant_id, email),
    CONSTRAINT identity_user_email_lookup_uq UNIQUE (tenant_id, email_lookup_hash),
    CONSTRAINT identity_user_email_lookup_ck CHECK (octet_length(email_lookup_hash) = 32),
    CONSTRAINT identity_user_email_canonical_ck CHECK (
        email = lower(btrim(email)) AND
        email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND
        length(email) <= 320
    ),
    CONSTRAINT identity_user_status_ck CHECK (status IN ('active', 'disabled')),
    CONSTRAINT identity_user_timestamp_ck CHECK (updated_at >= created_at)
);

CREATE TABLE botmem.workspace (
    id              uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL UNIQUE,
    display_name    text        NOT NULL,
    status          text        NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    CONSTRAINT workspace_owner_id_uq UNIQUE (tenant_id, id),
    -- Launch is intentionally one workspace per tenant. Hosted search's tenant
    -- key and public workspace ID are therefore identical, without an unsafe
    -- implicit lookup. A future multi-workspace migration must update adapters.
    CONSTRAINT workspace_launch_identity_ck CHECK (id = tenant_id),
    CONSTRAINT workspace_display_name_ck CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
    CONSTRAINT workspace_status_ck CHECK (status IN ('active', 'suspended', 'deleting')),
    CONSTRAINT workspace_timestamp_ck CHECK (updated_at >= created_at)
);

CREATE TABLE botmem.workspace_membership (
    tenant_id       uuid        NOT NULL,
    workspace_id    uuid        NOT NULL,
    user_id         uuid        NOT NULL,
    role            text        NOT NULL,
    status          text        NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT workspace_membership_owner_id_uq
        UNIQUE (tenant_id, workspace_id, user_id),
    CONSTRAINT workspace_membership_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES botmem.workspace (tenant_id, id),
    CONSTRAINT workspace_membership_user_fk
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES botmem.identity_user (tenant_id, id),
    CONSTRAINT workspace_membership_role_ck CHECK (role IN ('owner', 'member')),
    CONSTRAINT workspace_membership_status_ck CHECK (status IN ('active', 'revoked')),
    CONSTRAINT workspace_membership_timestamp_ck CHECK (updated_at >= created_at)
);

CREATE TABLE botmem.identity_credential (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    user_id             uuid        NOT NULL,
    kind                text        NOT NULL,
    secret_hash         bytea       NOT NULL UNIQUE,
    token_prefix        text        NOT NULL,
    label               text        NOT NULL,
    scopes              text[]      NOT NULL,
    created_at          timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    last_used_at        timestamptz,
    revoked_at          timestamptz,
    revocation_reason   text,
    rotated_from_id     uuid        UNIQUE,
    CONSTRAINT identity_credential_membership_fk
        FOREIGN KEY (tenant_id, workspace_id, user_id)
        REFERENCES botmem.workspace_membership (tenant_id, workspace_id, user_id),
    CONSTRAINT identity_credential_rotation_fk
        FOREIGN KEY (rotated_from_id)
        REFERENCES botmem.identity_credential (id),
    CONSTRAINT identity_credential_owner_id_uq
        UNIQUE (tenant_id, workspace_id, user_id, id),
    CONSTRAINT identity_credential_kind_ck
        CHECK (kind IN ('browser_session', 'personal_access_token')),
    CONSTRAINT identity_credential_hash_ck CHECK (octet_length(secret_hash) = 32),
    CONSTRAINT identity_credential_prefix_ck
        CHECK (token_prefix ~ '^[A-Za-z0-9_-]{8,24}$'),
    CONSTRAINT identity_credential_label_ck CHECK (length(btrim(label)) BETWEEN 1 AND 128),
    CONSTRAINT identity_credential_scopes_ck CHECK (
        cardinality(scopes) BETWEEN 1 AND 16 AND
        array_position(scopes, NULL) IS NULL AND
        (kind <> 'browser_session' OR scopes = ARRAY['browser']::text[]) AND
        (kind <> 'personal_access_token' OR 'botmem:search' = ANY(scopes))
    ),
    CONSTRAINT identity_credential_expiry_ck CHECK (expires_at > created_at),
    CONSTRAINT identity_credential_last_used_ck CHECK (
        last_used_at IS NULL OR (last_used_at >= created_at AND last_used_at <= expires_at)
    ),
    CONSTRAINT identity_credential_revocation_ck CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_at >= created_at AND
         revocation_reason IN ('user_revoked', 'rotated', 'membership_revoked', 'security_event'))
    ),
    CONSTRAINT identity_credential_not_self_rotated_ck CHECK (rotated_from_id IS DISTINCT FROM id)
);

CREATE TABLE botmem.identity_login_challenge (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    user_id             uuid        NOT NULL,
    secret_hash         bytea       NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    cancelled_at        timestamptz,
    CONSTRAINT identity_login_challenge_membership_fk
        FOREIGN KEY (tenant_id, workspace_id, user_id)
        REFERENCES botmem.workspace_membership (tenant_id, workspace_id, user_id),
    CONSTRAINT identity_login_challenge_hash_ck CHECK (octet_length(secret_hash) = 32),
    CONSTRAINT identity_login_challenge_expiry_ck CHECK (expires_at > created_at),
    CONSTRAINT identity_login_challenge_terminal_ck CHECK (
        NOT (consumed_at IS NOT NULL AND cancelled_at IS NOT NULL) AND
        (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at) AND
        (cancelled_at IS NULL OR cancelled_at >= created_at)
    )
);

CREATE INDEX identity_login_challenge_active_idx
    ON botmem.identity_login_challenge (tenant_id, workspace_id, user_id, expires_at)
    WHERE consumed_at IS NULL AND cancelled_at IS NULL;

CREATE FUNCTION botmem.enforce_identity_owner_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $identity_owner_update$
BEGIN
    IF TG_TABLE_NAME = 'identity_user' THEN
        IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
           NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'user ownership and creation identity are immutable'
                USING ERRCODE = '55000';
        END IF;
        IF (NEW.email IS DISTINCT FROM OLD.email) <>
           (NEW.email_lookup_hash IS DISTINCT FROM OLD.email_lookup_hash) THEN
            RAISE EXCEPTION 'email and lookup hash must rotate together'
                USING ERRCODE = '55000';
        END IF;
    ELSIF TG_TABLE_NAME = 'workspace' THEN
        IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
           NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'workspace ownership and creation identity are immutable'
                USING ERRCODE = '55000';
        END IF;
    ELSIF TG_TABLE_NAME = 'workspace_membership' THEN
        IF NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR
           NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'membership ownership and creation identity are immutable'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'identity update time cannot move backwards' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$identity_owner_update$;

REVOKE ALL ON FUNCTION botmem.enforce_identity_owner_updates() FROM PUBLIC;
CREATE TRIGGER identity_user_update_invariants
BEFORE UPDATE ON botmem.identity_user
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_identity_owner_updates();
CREATE TRIGGER workspace_update_invariants
BEFORE UPDATE ON botmem.workspace
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_identity_owner_updates();
CREATE TRIGGER workspace_membership_update_invariants
BEFORE UPDATE ON botmem.workspace_membership
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_identity_owner_updates();

CREATE INDEX identity_credential_owner_active_idx
    ON botmem.identity_credential (tenant_id, workspace_id, user_id, kind, expires_at)
    WHERE revoked_at IS NULL;

CREATE FUNCTION botmem.enforce_identity_credential_update()
RETURNS trigger
LANGUAGE plpgsql
AS $credential_update$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
       NEW.workspace_id <> OLD.workspace_id OR NEW.user_id <> OLD.user_id OR
       NEW.kind <> OLD.kind OR NEW.secret_hash <> OLD.secret_hash OR
       NEW.token_prefix <> OLD.token_prefix OR NEW.label <> OLD.label OR
       NEW.scopes <> OLD.scopes OR NEW.created_at <> OLD.created_at OR
       NEW.expires_at <> OLD.expires_at OR
       NEW.rotated_from_id IS DISTINCT FROM OLD.rotated_from_id THEN
        RAISE EXCEPTION 'credential identity and authority are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'revoked credentials are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.last_used_at IS NOT NULL AND OLD.last_used_at IS NOT NULL AND
       NEW.last_used_at < OLD.last_used_at THEN
        RAISE EXCEPTION 'credential last-used time cannot move backwards'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$credential_update$;

REVOKE ALL ON FUNCTION botmem.enforce_identity_credential_update() FROM PUBLIC;
CREATE TRIGGER identity_credential_update_invariants
BEFORE UPDATE ON botmem.identity_credential
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_identity_credential_update();

CREATE FUNCTION botmem.enforce_identity_login_challenge_update()
RETURNS trigger
LANGUAGE plpgsql
AS $login_challenge_update$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
       NEW.workspace_id <> OLD.workspace_id OR NEW.user_id <> OLD.user_id OR
       NEW.secret_hash <> OLD.secret_hash OR NEW.created_at <> OLD.created_at OR
       NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'login challenge identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF (OLD.consumed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL) AND
       NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal login challenges are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$login_challenge_update$;

REVOKE ALL ON FUNCTION botmem.enforce_identity_login_challenge_update() FROM PUBLIC;
CREATE TRIGGER identity_login_challenge_update_invariants
BEFORE UPDATE ON botmem.identity_login_challenge
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_identity_login_challenge_update();

ALTER TABLE botmem.identity_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_user FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.workspace_membership FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_login_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.identity_login_challenge FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_user_self_policy ON botmem.identity_user
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        id = botmem.current_user_id() AND status = 'active'
    );
CREATE POLICY identity_user_login_lookup_policy ON botmem.identity_user
    FOR SELECT TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        email_lookup_hash = botmem.current_login_email_hash() AND
        status = 'active'
    );
CREATE POLICY workspace_member_policy ON botmem.workspace
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        id = botmem.current_workspace_id() AND status = 'active'
    );
CREATE POLICY workspace_membership_self_policy ON botmem.workspace_membership
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        user_id = botmem.current_user_id()
    );
CREATE POLICY identity_credential_presented_policy ON botmem.identity_credential
    FOR SELECT TO botmem_api
    USING (secret_hash = botmem.current_credential_hash());
CREATE POLICY identity_credential_owner_select_policy ON botmem.identity_credential
    FOR SELECT TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        user_id = botmem.current_user_id()
    );
CREATE POLICY identity_credential_owner_insert_policy ON botmem.identity_credential
    FOR INSERT TO botmem_api
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        user_id = botmem.current_user_id()
    );
CREATE POLICY identity_credential_presented_update_policy ON botmem.identity_credential
    FOR UPDATE TO botmem_api
    USING (secret_hash = botmem.current_credential_hash())
    WITH CHECK (secret_hash = botmem.current_credential_hash());
CREATE POLICY identity_login_challenge_presented_policy
    ON botmem.identity_login_challenge FOR SELECT TO botmem_api
    USING (secret_hash = botmem.current_login_challenge_hash());
CREATE POLICY identity_login_challenge_owner_select_policy
    ON botmem.identity_login_challenge FOR SELECT TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        user_id = botmem.current_user_id()
    );
CREATE POLICY identity_login_challenge_owner_insert_policy
    ON botmem.identity_login_challenge FOR INSERT TO botmem_api
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id() AND
        user_id = botmem.current_user_id()
    );
CREATE POLICY identity_login_challenge_presented_update_policy
    ON botmem.identity_login_challenge FOR UPDATE TO botmem_api
    USING (secret_hash = botmem.current_login_challenge_hash())
    WITH CHECK (secret_hash = botmem.current_login_challenge_hash());

-- Provisioning is a distinct database identity, never a membership of the API
-- login. FORCE RLS still applies; these explicit policies are the auditable
-- cross-tenant authority used by billing/support account provisioning.
CREATE POLICY identity_user_admin_policy ON botmem.identity_user
    TO botmem_identity_admin USING (true) WITH CHECK (true);
CREATE POLICY workspace_admin_policy ON botmem.workspace
    TO botmem_identity_admin USING (true) WITH CHECK (true);
CREATE POLICY workspace_membership_admin_policy ON botmem.workspace_membership
    TO botmem_identity_admin USING (true) WITH CHECK (true);

GRANT SELECT (id, tenant_id, email_lookup_hash, status) ON botmem.identity_user TO botmem_api;
GRANT SELECT (id, tenant_id, status) ON botmem.workspace TO botmem_api;
GRANT SELECT (tenant_id, workspace_id, user_id, role, status)
    ON botmem.workspace_membership TO botmem_api;
GRANT SELECT (
    id, tenant_id, workspace_id, user_id, kind, secret_hash, scopes,
    expires_at, last_used_at, revoked_at
) ON botmem.identity_credential TO botmem_api;
GRANT INSERT ON botmem.identity_credential TO botmem_api;
GRANT UPDATE (last_used_at, revoked_at, revocation_reason)
    ON botmem.identity_credential TO botmem_api;
GRANT SELECT (id, tenant_id, workspace_id, user_id, secret_hash, created_at,
              expires_at, consumed_at, cancelled_at)
    ON botmem.identity_login_challenge TO botmem_api;
GRANT INSERT ON botmem.identity_login_challenge TO botmem_api;
GRANT UPDATE (consumed_at, cancelled_at) ON botmem.identity_login_challenge TO botmem_api;
GRANT USAGE ON SCHEMA botmem TO botmem_identity_admin;
GRANT SELECT, INSERT ON
    botmem.identity_user,
    botmem.workspace,
    botmem.workspace_membership
    TO botmem_identity_admin;
GRANT UPDATE (email, email_lookup_hash, status, updated_at)
    ON botmem.identity_user TO botmem_identity_admin;
GRANT UPDATE (display_name, status, updated_at)
    ON botmem.workspace TO botmem_identity_admin;
GRANT UPDATE (role, status, updated_at)
    ON botmem.workspace_membership TO botmem_identity_admin;

RESET ROLE;
