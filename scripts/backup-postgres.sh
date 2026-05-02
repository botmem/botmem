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

COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [ -n "$ENV_FILE" ]; then
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
fi

mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)
GLOBALS_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.globals.sql"
DB_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.dump"

echo "==> Writing globals backup: ${GLOBALS_BACKUP}"
"${COMPOSE[@]}" exec -T postgres pg_dumpall --globals-only -U "$POSTGRES_USER" > "$GLOBALS_BACKUP"

echo "==> Writing database backup: ${DB_BACKUP}"
"${COMPOSE[@]}" exec -T postgres pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" > "$DB_BACKUP"

test -s "$GLOBALS_BACKUP"
test -s "$DB_BACKUP"

echo "==> Backup complete"
echo "GLOBALS_BACKUP=${GLOBALS_BACKUP}"
echo "DB_BACKUP=${DB_BACKUP}"
