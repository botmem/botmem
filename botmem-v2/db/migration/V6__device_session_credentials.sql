-- Durable device session credential lifecycle. The table contains only session
-- identity and expiry metadata; relay frames, search payloads, corpus data, and
-- cursor state are deliberately excluded.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE TABLE botmem.device_session_credential (
    id                  uuid        PRIMARY KEY,
    generation          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
    tenant_id           uuid        NOT NULL,
    workspace_id        uuid        NOT NULL,
    device_id           uuid        NOT NULL,
    credential_version  bigint      NOT NULL,
    created_at          timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    revocation_reason   text,
    CONSTRAINT device_session_credential_device_fk
        FOREIGN KEY (tenant_id, workspace_id, device_id)
        REFERENCES botmem.device_registry (tenant_id, workspace_id, id),
    CONSTRAINT device_session_credential_version_ck CHECK (credential_version >= 1),
    CONSTRAINT device_session_credential_expiry_ck CHECK (
        expires_at > created_at AND expires_at <= created_at + interval '24 hours'
    ),
    CONSTRAINT device_session_credential_revocation_ck CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_at >= created_at AND
         revocation_reason IN ('replaced', 'device_revoked'))
    )
);

CREATE UNIQUE INDEX device_session_credential_one_active_idx
    ON botmem.device_session_credential (tenant_id, workspace_id, device_id)
    WHERE revoked_at IS NULL;

CREATE INDEX device_session_credential_expiry_idx
    ON botmem.device_session_credential (tenant_id, workspace_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE FUNCTION botmem.enforce_device_session_credential_update()
RETURNS trigger
LANGUAGE plpgsql
AS $device_credential_update$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
       NEW.workspace_id <> OLD.workspace_id OR NEW.device_id <> OLD.device_id OR
       NEW.credential_version <> OLD.credential_version OR
       NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'device session credential identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'revoked device session credentials are immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$device_credential_update$;

REVOKE ALL ON FUNCTION botmem.enforce_device_session_credential_update() FROM PUBLIC;
CREATE TRIGGER device_session_credential_update_invariants
BEFORE UPDATE ON botmem.device_session_credential
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_device_session_credential_update();

ALTER TABLE botmem.device_session_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.device_session_credential FORCE ROW LEVEL SECURITY;

CREATE POLICY device_session_credential_owner_policy ON botmem.device_session_credential
    TO botmem_api
    USING (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    )
    WITH CHECK (
        tenant_id = botmem.current_tenant_id() AND
        workspace_id = botmem.current_workspace_id()
    );

GRANT SELECT, INSERT ON botmem.device_session_credential TO botmem_api;
GRANT UPDATE (revoked_at, revocation_reason)
    ON botmem.device_session_credential TO botmem_api;
GRANT USAGE, SELECT ON SEQUENCE botmem.device_session_credential_generation_seq
    TO botmem_api;

RESET ROLE;
