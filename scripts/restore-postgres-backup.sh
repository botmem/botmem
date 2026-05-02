#!/usr/bin/env bash
# Restore a Botmem PostgreSQL custom-format backup into a Docker Compose stack.
#
# This drops and recreates POSTGRES_DB. It refuses to run unless CONFIRM_RESTORE
# matches the database name.
#
# Usage:
#   BACKUP_FILE=./backups/botmem-20260502T000000Z.dump CONFIRM_RESTORE=botmem scripts/restore-postgres-backup.sh
#   COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.prod BACKUP_FILE=/opt/botmem/backups/file.dump CONFIRM_RESTORE=botmem scripts/restore-postgres-backup.sh

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-}"
BACKUP_FILE="${BACKUP_FILE:?BACKUP_FILE is required}"
GLOBALS_FILE="${GLOBALS_FILE:-}"
POSTGRES_USER="${POSTGRES_USER:-botmem}"
POSTGRES_DB="${POSTGRES_DB:-botmem}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-}"
RESTORE_GLOBALS="${RESTORE_GLOBALS:-0}"

if [ "$CONFIRM_RESTORE" != "$POSTGRES_DB" ]; then
  echo "Refusing to restore. Set CONFIRM_RESTORE=${POSTGRES_DB} to drop and recreate ${POSTGRES_DB}." >&2
  exit 1
fi

test -s "$BACKUP_FILE"

COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -n "$ENV_FILE" ]; then
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
fi

echo "==> Stopping API before database restore"
"${COMPOSE[@]}" stop api >/dev/null 2>&1 || true

if [ "$RESTORE_GLOBALS" = "1" ] && [ -n "$GLOBALS_FILE" ]; then
  test -s "$GLOBALS_FILE"
  echo "==> Restoring globals from ${GLOBALS_FILE}"
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres < "$GLOBALS_FILE"
fi

echo "==> Dropping and recreating database ${POSTGRES_DB}"
"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${POSTGRES_DB};
CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
SQL

echo "==> Restoring database from ${BACKUP_FILE}"
"${COMPOSE[@]}" exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  --no-owner \
  --role="$POSTGRES_USER" \
  -d "$POSTGRES_DB" < "$BACKUP_FILE"

echo "==> Verifying pgvector extension"
"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"

echo "==> Restore complete. Start the API with:"
echo "    ${COMPOSE[*]} up -d api"
