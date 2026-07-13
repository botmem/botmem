\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.connector_account_id', '20000000-0000-4000-8000-000000000001', true);

INSERT INTO botmem.connector_oauth_state (
    state_digest, tenant_id, account_id, connector, sealed_pkce_verifier,
    redirect_uri, authority, scope, created_at, expires_at
) VALUES (
    decode(repeat('ab', 32), 'hex'),
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'gmail', repeat('s', 32), 'https://api.example/callback', NULL,
    'openid email gmail.readonly',
    '2026-07-13T10:00:00Z', '2026-07-13T10:10:00Z'
);

SELECT set_config('botmem.tenant_id', '', true);
DO $oauth_consume$
DECLARE
    consumed integer;
BEGIN
    SELECT count(*) INTO consumed
      FROM botmem.consume_connector_oauth_state(
          'gmail', repeat('ab', 32), '2026-07-13T10:01:00Z');
    IF consumed <> 1 THEN
        RAISE EXCEPTION 'valid OAuth state was not consumed exactly once';
    END IF;
    SELECT count(*) INTO consumed
      FROM botmem.consume_connector_oauth_state(
          'gmail', repeat('ab', 32), '2026-07-13T10:01:00Z');
    IF consumed <> 0 THEN
        RAISE EXCEPTION 'OAuth state was replayable';
    END IF;
END
$oauth_consume$;

SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('botmem.connector_account_id', '20000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.connector_credential (
    id, tenant_id, account_id, connector, secret_kind, key_version,
    wrap_nonce, wrapped_key, wrap_tag, payload_nonce, ciphertext, payload_tag,
    created_at, updated_at
) VALUES (
    '51000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'gmail', 'gmail_oauth', 1,
    decode(repeat('01', 12), 'hex'), decode(repeat('02', 32), 'hex'),
    decode(repeat('03', 16), 'hex'), decode(repeat('04', 12), 'hex'),
    decode(repeat('05', 32), 'hex'), decode(repeat('06', 16), 'hex'),
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);

SELECT set_config('botmem.connector_account_id', '20000000-0000-4000-8000-000000000002', true);
DO $owner_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.connector_credential) THEN
        RAISE EXCEPTION 'credential was visible outside its account owner context';
    END IF;
END
$owner_isolation$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $least_privilege$
BEGIN
    BEGIN
        PERFORM ciphertext FROM botmem.connector_credential;
        RAISE EXCEPTION 'dispatcher unexpectedly read connector credentials';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$least_privilege$;

ROLLBACK;
