#!/bin/bash
set -euo pipefail

umask 077

readonly ROLE_SQL=/opt/botmem/00_roles.sql
readonly SECRET_ROOT=/run/secrets

fail() {
  echo "database bootstrap: $*" >&2
  exit 78
}

read_secret() {
  local name="$1" path="$SECRET_ROOT/$2" value
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "$name secret is not a readable regular file"
  value="$(<"$path")"
  [[ "$value" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || fail "$name secret must be base64url"
  printf '%s' "$value"
}

[[ -f "$ROLE_SQL" && -r "$ROLE_SQL" ]] || fail 'role definition is not readable'
[[ -f "${ADMIN_DATABASE_URL_FILE:-}" && ! -L "$ADMIN_DATABASE_URL_FILE" ]] \
  || fail 'ADMIN_DATABASE_URL_FILE is not a regular file'
ADMIN_DATABASE_URL="$(<"$ADMIN_DATABASE_URL_FILE")"
[[ "$ADMIN_DATABASE_URL" == postgresql://* || "$ADMIN_DATABASE_URL" == postgres://* ]] \
  || fail 'admin database URL must use PostgreSQL'
[[ "$ADMIN_DATABASE_URL" == *'sslmode=verify-full'* ]] \
  || fail 'admin database URL must use sslmode=verify-full'
export PGSSLROOTCERT="$SECRET_ROOT/internal_ca_crt"
[[ -r "$PGSSLROOTCERT" ]] || fail 'internal CA is not readable'

declare -A passwords=(
  [api]="$(read_secret api api_database_password)"
  [sync]="$(read_secret sync sync_database_password)"
  [projection_worker]="$(read_secret projection-worker projection_worker_database_password)"
  [projection_dispatcher]="$(read_secret projection-dispatcher projection_dispatcher_database_password)"
  [commerce]="$(read_secret commerce commerce_database_password)"
  [identity_admin]="$(read_secret identity-admin identity_admin_database_password)"
  [lifecycle]="$(read_secret lifecycle lifecycle_database_password)"
  [migrator]="$(read_secret migrator migrator_database_password)"
)

sql="$(mktemp)"
trap 'rm -f "$sql"' EXIT
chmod 0600 "$sql"
for name in api sync projection_worker projection_dispatcher commerce identity_admin lifecycle migrator; do
  printf "\\set %s_password '%s'\n" "$name" "${passwords[$name]}" >> "$sql"
done
cat >> "$sql" <<'SQL'
\set ON_ERROR_STOP on

DO $bootstrap$
DECLARE
  login_name text;
BEGIN
  FOREACH login_name IN ARRAY ARRAY[
    'botmem_v2_api_login',
    'botmem_v2_sync_login',
    'botmem_v2_projection_login',
    'botmem_v2_dispatcher_login',
    'botmem_v2_commerce_login',
    'botmem_v2_identity_admin_login',
    'botmem_v2_lifecycle_login',
    'botmem_v2_migrator_login'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', login_name);
    END IF;
  END LOOP;
END
$bootstrap$;

ALTER ROLE botmem_v2_api_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_sync_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_projection_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_dispatcher_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_commerce_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_identity_admin_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE botmem_v2_lifecycle_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- The migration runner explicitly SETs its only reachable authority. It never
-- inherits schema-owner authority in the login session.
ALTER ROLE botmem_v2_migrator_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

SELECT format('ALTER ROLE botmem_v2_api_login PASSWORD %L', :'api_password') \gexec
SELECT format('ALTER ROLE botmem_v2_sync_login PASSWORD %L', :'sync_password') \gexec
SELECT format('ALTER ROLE botmem_v2_projection_login PASSWORD %L', :'projection_worker_password') \gexec
SELECT format('ALTER ROLE botmem_v2_dispatcher_login PASSWORD %L', :'projection_dispatcher_password') \gexec
SELECT format('ALTER ROLE botmem_v2_commerce_login PASSWORD %L', :'commerce_password') \gexec
SELECT format('ALTER ROLE botmem_v2_identity_admin_login PASSWORD %L', :'identity_admin_password') \gexec
SELECT format('ALTER ROLE botmem_v2_lifecycle_login PASSWORD %L', :'lifecycle_password') \gexec
SELECT format('ALTER ROLE botmem_v2_migrator_login PASSWORD %L', :'migrator_password') \gexec

DO $memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
      FROM pg_auth_members edge
      JOIN pg_roles granted ON granted.oid = edge.roleid
      JOIN pg_roles member ON member.oid = edge.member
     WHERE member.rolname IN (
       'botmem_v2_api_login', 'botmem_v2_sync_login',
       'botmem_v2_projection_login', 'botmem_v2_dispatcher_login',
       'botmem_v2_commerce_login', 'botmem_v2_identity_admin_login',
       'botmem_v2_lifecycle_login', 'botmem_v2_migrator_login'
     )
       AND granted.rolname IN (
         'botmem_api', 'botmem_worker', 'botmem_dispatcher', 'botmem_commerce',
         'botmem_identity_admin', 'botmem_lifecycle', 'botmem_migrator',
         'botmem_schema_owner'
       )
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
  END LOOP;
END
$memberships$;

GRANT botmem_api TO botmem_v2_api_login;
GRANT botmem_worker TO botmem_v2_sync_login;
GRANT botmem_worker TO botmem_v2_projection_login;
GRANT botmem_dispatcher TO botmem_v2_dispatcher_login;
GRANT botmem_commerce TO botmem_v2_commerce_login;
GRANT botmem_identity_admin TO botmem_v2_identity_admin_login;
GRANT botmem_lifecycle TO botmem_v2_lifecycle_login;
GRANT botmem_migrator TO botmem_v2_migrator_login;

REVOKE ALL ON DATABASE botmem_v2 FROM PUBLIC;
GRANT CONNECT ON DATABASE botmem_v2 TO
  botmem_v2_api_login, botmem_v2_sync_login, botmem_v2_projection_login,
  botmem_v2_dispatcher_login, botmem_v2_commerce_login,
  botmem_v2_identity_admin_login, botmem_v2_lifecycle_login,
  botmem_v2_migrator_login;
GRANT TEMPORARY ON DATABASE botmem_v2 TO botmem_v2_migrator_login;
GRANT CREATE ON DATABASE botmem_v2 TO botmem_schema_owner;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS botmem AUTHORIZATION botmem_schema_owner;
REVOKE ALL ON SCHEMA botmem FROM PUBLIC;

DO $verify$
DECLARE
  invalid_login text;
BEGIN
  SELECT role.rolname INTO invalid_login
  FROM pg_roles role
  WHERE role.rolname LIKE 'botmem_v2_%_login'
    AND (NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
      OR role.rolreplication OR role.rolbypassrls
      OR role.rolinherit)
  LIMIT 1;
  IF invalid_login IS NOT NULL THEN
    RAISE EXCEPTION 'unsafe Botmem login role: %', invalid_login;
  END IF;

  IF pg_has_role('botmem_v2_api_login', 'botmem_worker', 'MEMBER')
    OR pg_has_role('botmem_v2_api_login', 'botmem_identity_admin', 'MEMBER')
    OR pg_has_role('botmem_v2_sync_login', 'botmem_api', 'MEMBER')
    OR pg_has_role('botmem_v2_lifecycle_login', 'botmem_api', 'MEMBER')
    OR pg_has_role('botmem_v2_commerce_login', 'botmem_identity_admin', 'MEMBER')
  THEN
    RAISE EXCEPTION 'Botmem login role has a cross-boundary membership';
  END IF;
END
$verify$;
SQL

psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$ROLE_SQL" >/dev/null
psql "$ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$sql" >/dev/null
echo 'database bootstrap: exact login-role boundary verified'
