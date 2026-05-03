#!/usr/bin/env bash
# Back up Botmem PostgreSQL from a Docker Compose stack.
#
# Usage:
#   scripts/backup-postgres.sh
#   COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.prod scripts/backup-postgres.sh

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
POSTGRES_USER="${POSTGRES_USER:-botmem}"
POSTGRES_DB="${POSTGRES_DB:-botmem}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-30}"

COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -n "$ENV_FILE" ]; then
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
fi

mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)
GLOBALS_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.globals.sql"
DB_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.dump"
DB_BACKUP_PARTIAL="${DB_BACKUP}.partial"

wait_with_heartbeat() {
  local pid="$1"
  local label="$2"

  while kill -0 "$pid" 2>/dev/null; do
    sleep "$HEARTBEAT_INTERVAL"
    if kill -0 "$pid" 2>/dev/null; then
      echo "    ${label} still running..."
    fi
  done

  wait "$pid"
}

echo "==> Writing globals backup: ${GLOBALS_BACKUP}"
"${COMPOSE[@]}" exec -T postgres pg_dumpall --globals-only -U "$POSTGRES_USER" > "$GLOBALS_BACKUP"

echo "==> Writing database backup: ${DB_BACKUP}"
rm -f "$DB_BACKUP_PARTIAL"
(
  "${COMPOSE[@]}" exec -T postgres pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" > "$DB_BACKUP_PARTIAL"
) &
PG_DUMP_PID=$!
if ! wait_with_heartbeat "$PG_DUMP_PID" "PostgreSQL backup"; then
  echo "==> PostgreSQL backup failed"
  rm -f "$DB_BACKUP_PARTIAL" "$GLOBALS_BACKUP"
  exit 1
fi
mv "$DB_BACKUP_PARTIAL" "$DB_BACKUP"

test -s "$GLOBALS_BACKUP"
test -s "$DB_BACKUP"

echo "==> Backup complete"
echo "GLOBALS_BACKUP=${GLOBALS_BACKUP}"
echo "DB_BACKUP=${DB_BACKUP}"
