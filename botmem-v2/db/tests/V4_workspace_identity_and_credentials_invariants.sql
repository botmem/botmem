\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_identity_admin;
INSERT INTO botmem.identity_user (
    id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
)
VALUES (
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'owner@example.com', decode(repeat('ee', 32), 'hex'), 'active',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.workspace (id, tenant_id, display_name, status, created_at, updated_at)
VALUES (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Test workspace', 'active',
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.workspace_membership (
    tenant_id, workspace_id, user_id, role, status, created_at, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    'owner', 'active', '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

RESET ROLE;
SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.workspace_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.user_id', '41000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.identity_credential (
    id, tenant_id, workspace_id, user_id, kind, secret_hash, token_prefix,
    label, scopes, created_at, expires_at
) VALUES (
    '42000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    'browser_session', decode(repeat('aa', 32), 'hex'), 'AbCdEfGh1234',
    'Browser session', ARRAY['browser'],
    '2026-07-13T10:00:00Z', '2026-07-20T10:00:00Z'
);

INSERT INTO botmem.identity_login_challenge (
    id, tenant_id, workspace_id, user_id, secret_hash, created_at, expires_at
) VALUES (
    '43000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    decode(repeat('cc', 32), 'hex'),
    '2026-07-13T10:00:00Z', '2026-07-13T10:15:00Z'
);

DO $login_owner_visibility$
BEGIN
    IF (SELECT count(*) FROM botmem.identity_login_challenge
         WHERE tenant_id = '10000000-0000-4000-8000-000000000001'
           AND workspace_id = '10000000-0000-4000-8000-000000000001'
           AND user_id = '41000000-0000-4000-8000-000000000001') <> 1 THEN
        RAISE EXCEPTION 'login owner context cannot enforce challenge cooldown';
    END IF;
END
$login_owner_visibility$;

SELECT set_config('botmem.tenant_id', '', true);
SELECT set_config('botmem.workspace_id', '', true);
SELECT set_config('botmem.user_id', '', true);
SELECT set_config('botmem.credential_hash', repeat('aa', 32), true);
DO $presented_hash$
BEGIN
    IF (SELECT count(*) FROM botmem.identity_credential) <> 1 THEN
        RAISE EXCEPTION 'presented credential hash did not reveal exactly one row';
    END IF;
END
$presented_hash$;

SELECT set_config('botmem.credential_hash', repeat('bb', 32), true);
DO $wrong_hash$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.identity_credential) THEN
        RAISE EXCEPTION 'wrong credential hash exposed credential state';
    END IF;
END
$wrong_hash$;

SELECT set_config('botmem.login_challenge_hash', repeat('cc', 32), true);
UPDATE botmem.identity_login_challenge
   SET consumed_at = '2026-07-13T10:02:00Z'
 WHERE id = '43000000-0000-4000-8000-000000000001';
DO $login_single_use$
BEGIN
    BEGIN
        UPDATE botmem.identity_login_challenge
           SET consumed_at = '2026-07-13T10:03:00Z'
         WHERE id = '43000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'consumed login challenge remained mutable';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
END
$login_single_use$;

SELECT set_config('botmem.credential_hash', repeat('aa', 32), true);
UPDATE botmem.identity_credential
   SET revoked_at = '2026-07-13T10:01:00Z', revocation_reason = 'user_revoked'
 WHERE id = '42000000-0000-4000-8000-000000000001';
DO $immutable_revoked$
BEGIN
    BEGIN
        UPDATE botmem.identity_credential
           SET last_used_at = '2026-07-13T10:02:00Z'
         WHERE id = '42000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'revoked credential remained mutable';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'botmem' AND table_name = 'identity_credential'
           AND column_name IN ('token', 'secret', 'session', 'access_token', 'magic_link')
    ) THEN
        RAISE EXCEPTION 'plaintext identity secret column exists';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'botmem' AND table_name = 'identity_login_challenge'
           AND column_name IN ('token', 'code', 'magic_link', 'email')
    ) THEN
        RAISE EXCEPTION 'plaintext login challenge column exists';
    END IF;
END
$immutable_revoked$;

RESET ROLE;
SET LOCAL ROLE botmem_identity_admin;
DO $identity_admin_least_privilege$
BEGIN
    BEGIN
        PERFORM secret_hash FROM botmem.identity_credential;
        RAISE EXCEPTION 'identity provisioning role unexpectedly read credential hashes';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM secret_hash FROM botmem.identity_login_challenge;
        RAISE EXCEPTION 'identity provisioning role unexpectedly read login hashes';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$identity_admin_least_privilege$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $least_privilege$
BEGIN
    BEGIN
        PERFORM secret_hash FROM botmem.identity_credential;
        RAISE EXCEPTION 'dispatcher unexpectedly read credential hashes';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$least_privilege$;

ROLLBACK;
