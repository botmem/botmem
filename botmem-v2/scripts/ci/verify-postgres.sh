#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${BOTMEM_CI_ADMIN_DATABASE_URL:?BOTMEM_CI_ADMIN_DATABASE_URL is required}"
: "${BOTMEM_CI_DATABASE_URL:?BOTMEM_CI_DATABASE_URL is required}"
: "${BOTMEM_CI_MIGRATOR_DATABASE_URL:?BOTMEM_CI_MIGRATOR_DATABASE_URL is required}"

psql "$BOTMEM_CI_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE botmem_v2_ci'
psql "$BOTMEM_CI_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/db/bootstrap/00_roles.sql"
psql "$BOTMEM_CI_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE botmem_ci_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE botmem_test_api LOGIN NOINHERIT;
CREATE ROLE botmem_test_worker LOGIN NOINHERIT;
CREATE ROLE botmem_test_dispatcher LOGIN NOINHERIT;
CREATE ROLE botmem_test_commerce LOGIN NOINHERIT;
CREATE ROLE botmem_test_identity_admin LOGIN NOINHERIT;
CREATE ROLE botmem_test_lifecycle LOGIN NOINHERIT;
GRANT botmem_migrator TO botmem_ci_migrator;
GRANT botmem_api TO botmem_test_api;
GRANT botmem_worker TO botmem_test_worker;
GRANT botmem_dispatcher TO botmem_test_dispatcher;
GRANT botmem_commerce TO botmem_test_commerce;
GRANT botmem_identity_admin TO botmem_test_identity_admin;
GRANT botmem_lifecycle TO botmem_test_lifecycle;
SQL
psql "$BOTMEM_CI_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'GRANT CREATE ON DATABASE botmem_v2_ci TO botmem_schema_owner' \
  -c 'CREATE EXTENSION vector'

pnpm --filter @botmem-v2/migrator build >/dev/null
run_migrator() {
  NODE_ENV=test \
  MIGRATOR_EXPECTED_LOGIN=botmem_ci_migrator \
  MIGRATIONS_DIR="${1:-$ROOT/db/migration}" \
  DATABASE_URL="$BOTMEM_CI_MIGRATOR_DATABASE_URL" \
    node "$ROOT/apps/migrator/dist/bin.js"
}

temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT
run_migrator >"$temporary_root/concurrent-a.log" 2>&1 &
first_pid=$!
run_migrator >"$temporary_root/concurrent-b.log" 2>&1 &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
grep -Eq '"appliedCount":15' "$temporary_root/concurrent-a.log" "$temporary_root/concurrent-b.log"
grep -Eq '"appliedCount":0' "$temporary_root/concurrent-a.log" "$temporary_root/concurrent-b.log"

run_migrator >"$temporary_root/no-op.log" 2>&1
grep -q '"previouslyAppliedCount":15,"appliedCount":0' "$temporary_root/no-op.log"

cp -R "$ROOT/db/migration" "$temporary_root/tampered"
printf '\n-- checksum drift fixture\n' >>"$temporary_root/tampered/V15__fenced_worker_leases.sql"
if run_migrator "$temporary_root/tampered" >"$temporary_root/tamper.log" 2>&1; then
  echo 'tampered migration unexpectedly passed' >&2
  exit 1
fi
grep -q '"code":"migration_checksum_drift"' "$temporary_root/tamper.log"

cp -R "$ROOT/db/migration" "$temporary_root/failed"
printf '%s\n' \
  'CREATE TABLE botmem.failed_migration_transaction_fixture (id bigint PRIMARY KEY);' \
  'SELECT 1 / 0;' \
  >"$temporary_root/failed/V16__forced_transaction_failure.sql"
if run_migrator "$temporary_root/failed" >"$temporary_root/failure.log" 2>&1; then
  echo 'failed migration unexpectedly passed' >&2
  exit 1
fi
grep -q '"code":"migration_failed","script":"V16__forced_transaction_failure.sql"' \
  "$temporary_root/failure.log"
psql "$BOTMEM_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('botmem.failed_migration_transaction_fixture') IS NULL
          AND (SELECT count(*) = 15 FROM botmem_migration.history)" \
  | grep -qx t

while IFS= read -r invariant; do
  psql "$BOTMEM_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$invariant" >/dev/null
done < <(find "$ROOT/db/tests" -maxdepth 1 -type f -name 'V*.sql' -print | sort -V)

psql "$BOTMEM_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('botmem.hosted_sync_job') IS NOT NULL
          AND to_regclass('botmem.device_session_credential') IS NOT NULL
          AND to_regclass('botmem.hosted_document_head') IS NOT NULL
          AND to_regclass('botmem.stripe_webhook_event') IS NOT NULL
          AND to_regclass('botmem.commerce_reconciler_heartbeat') IS NOT NULL" \
  | grep -qx t
psql "$BOTMEM_CI_MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $roles$
BEGIN
  IF pg_has_role(current_user, 'botmem_api', 'member')
     OR pg_has_role(current_user, 'botmem_commerce', 'member')
     OR pg_has_role(current_user, 'botmem_worker', 'member')
     OR pg_has_role(current_user, 'botmem_dispatcher', 'member') THEN
    RAISE EXCEPTION 'migrator unexpectedly has a runtime role';
  END IF;
END
$roles$;
SQL

psql "$BOTMEM_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) = 15
          AND count(*) FILTER (WHERE source = 'botmem_node') = 15
          AND min(version) = 1
          AND max(version) = 15
     FROM botmem_migration.history" \
  | grep -qx t

if psql "$BOTMEM_CI_MIGRATOR_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE botmem_schema_owner' \
  -c "UPDATE botmem_migration.history SET description = description WHERE version = 1" \
  >"$temporary_root/immutable.log" 2>&1; then
  echo 'immutable migration history unexpectedly accepted an update' >&2
  exit 1
fi
grep -q 'Botmem migration history is immutable' "$temporary_root/immutable.log"

# Prove a deployment upgraded from the former Flyway runtime can import its
# verified history exactly once without replaying application DDL.
legacy_database_url="${BOTMEM_CI_MIGRATOR_DATABASE_URL/botmem_v2_ci/botmem_v2_legacy_ci}"
psql "$BOTMEM_CI_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE botmem_v2_legacy_ci' >/dev/null
psql "${BOTMEM_CI_DATABASE_URL/botmem_v2_ci/botmem_v2_legacy_ci}" -v ON_ERROR_STOP=1 \
  -c 'GRANT CREATE ON DATABASE botmem_v2_legacy_ci TO botmem_schema_owner' \
  -c 'CREATE EXTENSION vector' >/dev/null
while IFS= read -r migration; do
  psql "$legacy_database_url" -X -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done < <(find "$ROOT/db/migration" -maxdepth 1 -type f -name 'V*.sql' -print | sort -V)
psql "$legacy_database_url" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SET ROLE botmem_schema_owner;
CREATE TABLE botmem.flyway_schema_history (
  installed_rank integer NOT NULL PRIMARY KEY,
  version varchar(50),
  description varchar(200) NOT NULL,
  type varchar(20) NOT NULL,
  script varchar(1000) NOT NULL,
  checksum integer,
  installed_by varchar(100) NOT NULL DEFAULT current_user,
  installed_on timestamptz NOT NULL DEFAULT now(),
  execution_time integer NOT NULL DEFAULT 0,
  success boolean NOT NULL
);
SQL
ROOT="$ROOT" node --input-type=module <<'JS' >"$temporary_root/legacy-history.sql"
import { discoverMigrations } from './apps/migrator/dist/migrations.js';
const migrations = await discoverMigrations(`${process.env.ROOT}/db/migration`);
for (const migration of migrations) {
  const description = migration.description.replaceAll("'", "''");
  const script = migration.script.replaceAll("'", "''");
  process.stdout.write(
    `INSERT INTO botmem.flyway_schema_history (installed_rank, version, description, type, script, checksum, success) VALUES (${migration.version}, '${migration.version}', '${description}', 'SQL', '${script}', ${migration.flywayChecksum}, true);\n`,
  );
}
JS
psql "$legacy_database_url" -X -v ON_ERROR_STOP=1 \
  -c 'SET ROLE botmem_schema_owner' \
  -f "$temporary_root/legacy-history.sql" >/dev/null
NODE_ENV=test \
MIGRATOR_EXPECTED_LOGIN=botmem_ci_migrator \
MIGRATIONS_DIR="$ROOT/db/migration" \
DATABASE_URL="$legacy_database_url" \
  node "$ROOT/apps/migrator/dist/bin.js" >"$temporary_root/legacy-import.log" 2>&1
grep -q '"appliedCount":0,"importedLegacyCount":15' "$temporary_root/legacy-import.log"
