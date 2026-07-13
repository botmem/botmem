#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

table_counts() {
  local database_url="$1"
  psql "$database_url" -X -At <<'SQL' | LC_ALL=C sort
SELECT format(
  'SELECT %L || ''|'' || count(*)::text FROM %I.%I',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname = 'botmem'
ORDER BY schemaname, tablename;
\gexec
SQL
}

require_tls() {
  local database_url="$1"
  if [[ "$database_url" == *"@127.0.0.1"* || "$database_url" == *"@localhost"* ]]; then
    [[ "${BOTMEM_ALLOW_INSECURE_LOCAL_RESTORE:-}" == "true" ]] || {
      echo "localhost restore requires BOTMEM_ALLOW_INSECURE_LOCAL_RESTORE=true" >&2
      exit 2
    }
    return
  fi
  [[ "$database_url" == *"sslmode=verify-full"* ]] || {
    echo "all non-local database URLs must use sslmode=verify-full" >&2
    exit 2
  }
  [[ -n "${PGSSLROOTCERT:-}" && -r "$PGSSLROOTCERT" ]] || {
    echo "PGSSLROOTCERT must name a readable CA bundle" >&2
    exit 2
  }
}

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${RESTORE_ADMIN_DATABASE_URL:?RESTORE_ADMIN_DATABASE_URL is required}"
: "${RESTORE_MIGRATOR_DATABASE_URL:?RESTORE_MIGRATOR_DATABASE_URL is required}"
[[ "${BOTMEM_RESTORE_CONFIRM:-}" == "botmem_restore_verification" ]] || {
  echo "BOTMEM_RESTORE_CONFIRM must equal botmem_restore_verification" >&2
  exit 2
}

require_tls "$BACKUP_DATABASE_URL"
require_tls "$RESTORE_ADMIN_DATABASE_URL"
require_tls "$RESTORE_MIGRATOR_DATABASE_URL"

RESTORE_DATABASE_NAME="$(psql "$RESTORE_ADMIN_DATABASE_URL" -X -Atc 'SELECT current_database()')"
[[ "$RESTORE_DATABASE_NAME" =~ _restore_verify$ ]] || {
  echo "restore target database name must end with _restore_verify" >&2
  exit 2
}
EMPTY_TABLES="$(psql "$RESTORE_ADMIN_DATABASE_URL" -X -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')")"
[[ "$EMPTY_TABLES" == "0" ]] || {
  echo "restore target is not empty" >&2
  exit 2
}

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
DUMP="$WORK/botmem.dump"

pg_dump "$BACKUP_DATABASE_URL" \
  --format=custom --compress=9 --no-acl --file="$DUMP"
pg_restore --list "$DUMP" >/dev/null

psql "$RESTORE_ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ROOT/db/bootstrap/00_roles.sql" >/dev/null
psql "$RESTORE_ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "GRANT CREATE ON DATABASE \"$RESTORE_DATABASE_NAME\" TO botmem_schema_owner" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
pg_restore --exit-on-error --no-acl \
  --dbname="$RESTORE_MIGRATOR_DATABASE_URL" "$DUMP"

table_counts "$BACKUP_DATABASE_URL" > "$WORK/source-counts"
table_counts "$RESTORE_ADMIN_DATABASE_URL" > "$WORK/restored-counts"
diff -u "$WORK/source-counts" "$WORK/restored-counts"

for invariant in "$ROOT"/db/tests/V*.sql; do
  psql "$RESTORE_ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$invariant" >/dev/null
done

psql "$RESTORE_ADMIN_DATABASE_URL" -X -Atc \
  "SELECT count(*) = 0
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     JOIN pg_attribute tenant_column
       ON tenant_column.attrelid = relation.oid
      AND tenant_column.attname = 'tenant_id'
      AND NOT tenant_column.attisdropped
    WHERE namespace.nspname = 'botmem' AND relation.relkind IN ('r','p')
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)" \
  | grep -qx t
psql "$RESTORE_ADMIN_DATABASE_URL" -X -Atc \
  "SELECT pg_has_role('botmem_api', 'botmem_worker', 'member')
          OR pg_has_role('botmem_api', 'botmem_dispatcher', 'member')" \
  | grep -qx f

echo "restore verification passed for $RESTORE_DATABASE_NAME"
