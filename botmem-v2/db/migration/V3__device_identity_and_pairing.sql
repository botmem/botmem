-- Durable device identity only. Live relay presence and search frames belong in
-- the replica-neutral ephemeral transport and are intentionally absent here.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE FUNCTION botmem.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
RETURN NULLIF(current_setting('botmem.workspace_id', true), '')::uuid;

REVOKE ALL ON FUNCTION botmem.current_workspace_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.current_workspace_id() TO botmem_api;

CREATE TABLE botmem.device_registry (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    display_name        text        NOT NULL,
    key_id              text        NOT NULL,
    public_key          bytea       NOT NULL,
    connectors          text[]      NOT NULL,
    status              text        NOT NULL DEFAULT 'active',
    credential_version  bigint      NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    revocation_reason   text,
    CONSTRAINT device_registry_owner_id_uq UNIQUE (tenant_id, workspace_id, id),
    CONSTRAINT device_registry_owner_key_id_uq UNIQUE (tenant_id, workspace_id, key_id),
    CONSTRAINT device_registry_owner_public_key_uq UNIQUE (tenant_id, workspace_id, public_key),
    CONSTRAINT device_registry_display_name_ck
        CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
    CONSTRAINT device_registry_key_id_ck
        CHECK (length(btrim(key_id)) BETWEEN 1 AND 128),
    CONSTRAINT device_registry_public_key_ck CHECK (octet_length(public_key) = 32),
    CONSTRAINT device_registry_connectors_ck CHECK (
        connectors = ARRAY['imessage']::text[] OR
        connectors = ARRAY['whatsapp']::text[] OR
        connectors = ARRAY['imessage', 'whatsapp']::text[]
    ),
    CONSTRAINT device_registry_status_ck CHECK (status IN ('active', 'revoked')),
    CONSTRAINT device_registry_version_ck CHECK (credential_version >= 1),
    CONSTRAINT device_registry_timestamp_ck CHECK (updated_at >= created_at),
    CONSTRAINT device_registry_revocation_ck CHECK (
        (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
        (status = 'revoked' AND revoked_at IS NOT NULL AND
         revocation_reason IN ('user_revoked', 'credential_rotated', 'device_deleted'))
    )
);

CREATE INDEX device_registry_workspace_status_idx
    ON botmem.device_registry (tenant_id, workspace_id, status, id);

CREATE FUNCTION botmem.enforce_device_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $device_update$
DECLARE
    security_changed boolean;
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
       NEW.workspace_id <> OLD.workspace_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'device ownership and creation identity are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'revoked device rows are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF (NEW.key_id IS DISTINCT FROM OLD.key_id) <>
       (NEW.public_key IS DISTINCT FROM OLD.public_key) THEN
        RAISE EXCEPTION 'device key id and public key must rotate together'
            USING ERRCODE = '55000';
    END IF;
    security_changed :=
        NEW.key_id IS DISTINCT FROM OLD.key_id OR
        NEW.public_key IS DISTINCT FROM OLD.public_key OR
        NEW.status IS DISTINCT FROM OLD.status;
    IF security_changed AND NEW.credential_version <> OLD.credential_version + 1 THEN
        RAISE EXCEPTION 'security changes must increment credential version exactly once'
            USING ERRCODE = '55000';
    ELSIF NOT security_changed AND NEW.credential_version <> OLD.credential_version THEN
        RAISE EXCEPTION 'non-security changes cannot alter credential version'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$device_update$;

REVOKE ALL ON FUNCTION botmem.enforce_device_identity_update() FROM PUBLIC;
CREATE TRIGGER device_registry_update_invariants
BEFORE UPDATE ON botmem.device_registry
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_device_identity_update();

CREATE TABLE botmem.device_pairing_grant (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    code_hash           bytea       NOT NULL UNIQUE,
    expires_at          timestamptz NOT NULL,
    created_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    CONSTRAINT device_pairing_grant_hash_ck CHECK (octet_length(code_hash) = 32),
    CONSTRAINT device_pairing_grant_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
    ),
    CONSTRAINT device_pairing_grant_consumed_ck CHECK (
        consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)
    )
);

CREATE INDEX device_pairing_grant_redeem_idx
    ON botmem.device_pairing_grant (tenant_id, workspace_id, code_hash, expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE botmem.device_auth_challenge (
    id                  uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    device_id           uuid        NOT NULL,
    key_id              text        NOT NULL,
    client_nonce_hash   bytea       NOT NULL,
    server_nonce_hash   bytea       NOT NULL,
    expires_at          timestamptz NOT NULL,
    created_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    CONSTRAINT device_auth_challenge_device_fk
        FOREIGN KEY (tenant_id, workspace_id, device_id)
        REFERENCES botmem.device_registry (tenant_id, workspace_id, id),
    CONSTRAINT device_auth_challenge_key_id_ck
        CHECK (length(btrim(key_id)) BETWEEN 1 AND 128),
    CONSTRAINT device_auth_challenge_client_hash_ck
        CHECK (octet_length(client_nonce_hash) = 32),
    CONSTRAINT device_auth_challenge_server_hash_ck
        CHECK (octet_length(server_nonce_hash) = 32),
    CONSTRAINT device_auth_challenge_nonce_uq
        UNIQUE (device_id, client_nonce_hash, server_nonce_hash),
    CONSTRAINT device_auth_challenge_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '2 minutes'
    ),
    CONSTRAINT device_auth_challenge_consumed_ck CHECK (
        consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)
    )
);

CREATE INDEX device_auth_challenge_consume_idx
    ON botmem.device_auth_challenge (
        tenant_id, workspace_id, device_id, key_id,
        client_nonce_hash, server_nonce_hash, expires_at
    ) WHERE consumed_at IS NULL;

CREATE FUNCTION botmem.enforce_single_use_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $single_use$
BEGIN
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'single-use security record cannot be reopened or re-consumed'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$single_use$;

REVOKE ALL ON FUNCTION botmem.enforce_single_use_consumption() FROM PUBLIC;
CREATE TRIGGER device_pairing_grant_single_use
BEFORE UPDATE OF consumed_at ON botmem.device_pairing_grant
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_single_use_consumption();
CREATE TRIGGER device_auth_challenge_single_use
BEFORE UPDATE OF consumed_at ON botmem.device_auth_challenge
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_single_use_consumption();

ALTER TABLE botmem.device_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_pairing_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_pairing_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_auth_challenge FORCE ROW LEVEL SECURITY;

CREATE POLICY device_registry_owner_policy ON botmem.device_registry
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    );
CREATE POLICY device_pairing_grant_owner_policy ON botmem.device_pairing_grant
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    );
CREATE POLICY device_auth_challenge_owner_policy ON botmem.device_auth_challenge
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    );

GRANT SELECT, INSERT ON botmem.device_registry TO botmem_api;
GRANT UPDATE (
    display_name, key_id, public_key, connectors, status,
    credential_version, updated_at, revoked_at, revocation_reason
) ON botmem.device_registry TO botmem_api;

GRANT SELECT, INSERT ON botmem.device_pairing_grant TO botmem_api;
GRANT UPDATE (consumed_at) ON botmem.device_pairing_grant TO botmem_api;

GRANT SELECT, INSERT ON botmem.device_auth_challenge TO botmem_api;
GRANT UPDATE (consumed_at) ON botmem.device_auth_challenge TO botmem_api;

RESET ROLE;
