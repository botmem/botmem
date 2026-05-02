#!/usr/bin/env bash
# Deploy Botmem API with health check and automatic rollback
#
# Usage: deploy.sh <image-tag>
#
# Pulls the new image, recreates the API container, validates health,
# and automatically rolls back to the previous version if the health
# check fails.
#
# Manual rollback: deploy.sh <previous-tag>

set -euo pipefail

IMAGE_TAG="${1:?Usage: deploy.sh <image-tag>}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/botmem}"
ENV_FILE="${DEPLOY_DIR}/.env.prod"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"
BACKUP_DIR="${DEPLOY_DIR}/backups"
HEALTH_TIMEOUT=180   # seconds to wait for health check (NestJS can take 2+ min on 2GB VPS)
HEALTH_INTERVAL=5    # seconds between health check attempts
POSTGRES_USER="${POSTGRES_USER:-botmem}"
POSTGRES_DB="${POSTGRES_DB:-botmem}"
RUN_SEARCH_BACKFILL="${RUN_SEARCH_BACKFILL:-1}"
REMOVE_LEGACY_SEARCH_AFTER_BACKFILL="${REMOVE_LEGACY_SEARCH_AFTER_BACKFILL:-1}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-2}"
MIN_FREE_SPACE_AFTER_BACKUP_GB="${MIN_FREE_SPACE_AFTER_BACKUP_GB:-8}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

show_disk_usage() {
  df -h / || true
  docker system df || true
}

wait_with_heartbeat() {
  local pid="$1"
  local label="$2"
  local interval="${3:-30}"

  while kill -0 "$pid" 2>/dev/null; do
    sleep "$interval"
    if kill -0 "$pid" 2>/dev/null; then
      echo "    ${label} still running..."
    fi
  done

  wait "$pid"
}

prune_old_backups() {
  mkdir -p "$BACKUP_DIR"

  if [ "$BACKUP_KEEP_COUNT" -lt 1 ]; then
    echo "==> BACKUP_KEEP_COUNT must be at least 1"
    exit 1
  fi

  mapfile -t EXISTING_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'botmem-*.dump' | sort)
  for backup in "${EXISTING_BACKUPS[@]}"; do
    backup_base=$(basename "$backup")
    if ! docker run --rm -v "${BACKUP_DIR}:/backups:ro" pgvector/pgvector:pg16 pg_restore -l "/backups/${backup_base}" >/dev/null 2>&1; then
      echo "==> Removing invalid or incomplete PostgreSQL backup: ${backup}"
      rm -f "$backup" "${backup%.dump}.globals.sql"
    fi
  done

  mapfile -t OLD_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'botmem-*.dump' | sort -r | tail -n +"$((BACKUP_KEEP_COUNT + 1))")
  if [ "${#OLD_BACKUPS[@]}" -eq 0 ]; then
    return
  fi

  echo "==> Removing old PostgreSQL backups beyond newest ${BACKUP_KEEP_COUNT}"
  for backup in "${OLD_BACKUPS[@]}"; do
    globals="${backup%.dump}.globals.sql"
    rm -f "$backup" "$globals"
  done
}

cleanup_docker_host() {
  local phase="${1:-manual}"

  echo "==> Docker host cleanup (${phase})"
  show_disk_usage

  docker container prune -f || true
  docker image prune -af || true
  docker builder prune -af || true
  docker network prune -f || true

  if [ "${PRUNE_DOCKER_VOLUMES:-0}" = "1" ]; then
    echo "==> PRUNE_DOCKER_VOLUMES=1; pruning unused Docker volumes"
    docker volume prune -f || true
  fi

  show_disk_usage
}

bytes_available_on_root() {
  df -PB1 / | awk 'NR == 2 { print $4 }'
}

postgres_database_size_bytes() {
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
    -c "SELECT pg_database_size('${POSTGRES_DB}')"
}

require_backup_space() {
  local available_bytes
  local db_size_bytes
  local reserve_bytes
  local required_bytes

  available_bytes=$(bytes_available_on_root)
  db_size_bytes=$(postgres_database_size_bytes)
  reserve_bytes=$((MIN_FREE_SPACE_AFTER_BACKUP_GB * 1024 * 1024 * 1024))
  required_bytes=$((db_size_bytes + reserve_bytes))

  echo "==> Backup space preflight"
  echo "    available_on_root_bytes=${available_bytes}"
  echo "    postgres_database_size_bytes=${db_size_bytes}"
  echo "    required_bytes=db_size + ${MIN_FREE_SPACE_AFTER_BACKUP_GB}GiB reserve = ${required_bytes}"

  if [ "$available_bytes" -lt "$required_bytes" ]; then
    echo "==> Refusing to create on-host PostgreSQL backup: insufficient free space"
    echo "==> Free more disk, lower MIN_FREE_SPACE_AFTER_BACKUP_GB, or take an off-host backup first."
    exit 1
  fi
}

remove_legacy_search_storage() {
  local legacy_service="type""sense"
  local legacy_volume="type""sense-data"

  echo "==> Removing old legacy search container(s) and data volume(s)"
  docker ps -aq --filter "label=com.docker.compose.service=${legacy_service}" | xargs -r docker rm -f
  docker volume ls -q --filter "label=com.docker.compose.volume=${legacy_volume}" | xargs -r docker volume rm
  docker volume ls -q | awk -v volume="${legacy_volume}" '$0 == volume || $0 ~ "_" volume "$"' | xargs -r docker volume rm
}

echo "==> Deploying ghcr.io/botmem/botmem:${IMAGE_TAG}"

# ── Save previous version for rollback ──────────────────────────────────────
PREV_TAG=""
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  PREV_TAG=$(grep '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)
fi
echo "==> Previous version: ${PREV_TAG:-none}"

cd "$DEPLOY_DIR"

# ── Free space before backup/pull on small VPS disks ─────────────────────────
# This only removes unused Docker objects. Named, attached database volumes are
# not removed unless PRUNE_DOCKER_VOLUMES=1 is set explicitly.
cleanup_docker_host "preflight"
prune_old_backups
require_backup_space

# ── Back up PostgreSQL before image/schema changes ─────────────────────────
mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)
GLOBALS_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.globals.sql"
DB_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.dump"
DB_BACKUP_PARTIAL="${DB_BACKUP}.partial"

echo "==> Backing up PostgreSQL to ${DB_BACKUP}"
rm -f "$DB_BACKUP_PARTIAL"
"${COMPOSE[@]}" exec -T postgres pg_dumpall --globals-only -U "$POSTGRES_USER" > "$GLOBALS_BACKUP"
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
echo "==> PostgreSQL backup complete"

# ── Recreate Postgres with pgvector image and verify extension ──────────────
echo "==> Ensuring PostgreSQL is running with pgvector support"
"${COMPOSE[@]}" up -d --no-deps postgres

PG_WAIT=0
until "${COMPOSE[@]}" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  if [ "$PG_WAIT" -ge 60 ]; then
    echo "==> PostgreSQL did not become ready after pgvector image switch"
    exit 1
  fi
  sleep 2
  PG_WAIT=$((PG_WAIT + 2))
done

"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"

# ── Update IMAGE_TAG in .env.prod only after backup/preflight succeeds ──────
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "# Docker image version (managed by deploy.sh)" >> "$ENV_FILE"
  echo "IMAGE_TAG=${IMAGE_TAG}" >> "$ENV_FILE"
fi

# ── Pull new image ──────────────────────────────────────────────────────────
docker pull "ghcr.io/botmem/botmem:${IMAGE_TAG}"

# ── Recreate only the API container (infra stays running) ───────────────────
"${COMPOSE[@]}" up -d --no-deps api

# ── Health check via Docker network (port not exposed to host) ──────────────
check_health() {
  docker exec botmem-caddy-1 wget -q -O- http://api:12412/api/version 2>/dev/null || echo ""
}

echo "==> Waiting up to ${HEALTH_TIMEOUT}s for API health check..."
ELAPSED=0
HEALTHY=false

while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  RESPONSE=$(check_health)
  if [ -n "$RESPONSE" ]; then
    echo "==> Health check passed (${ELAPSED}s): $RESPONSE"
    HEALTHY=true
    break
  fi
  echo "    Attempt $((ELAPSED / HEALTH_INTERVAL + 1)): not ready yet..."
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

# ── Rollback if health check failed ────────────────────────────────────────
if [ "$HEALTHY" = false ]; then
  echo "==> HEALTH CHECK FAILED after ${HEALTH_TIMEOUT}s"
  echo "==> API container status:"
  "${COMPOSE[@]}" ps api || true
  echo "==> Recent API logs:"
  docker logs --tail 120 botmem-api-1 || true

  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
    echo "==> ROLLING BACK to ${PREV_TAG}"

    # Restore previous version in .env.prod
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"

    # Recreate with previous image
    "${COMPOSE[@]}" up -d --no-deps api

    # Wait for rollback to come up
    ROLLBACK_WAIT=60
    ROLLBACK_ELAPSED=0
    ROLLBACK_OK=false
    while [ "$ROLLBACK_ELAPSED" -lt "$ROLLBACK_WAIT" ]; do
      RESPONSE=$(check_health)
      if [ -n "$RESPONSE" ]; then
        echo "==> Rollback successful — running ${PREV_TAG}: $RESPONSE"
        ROLLBACK_OK=true
        break
      fi
      sleep 5
      ROLLBACK_ELAPSED=$((ROLLBACK_ELAPSED + 5))
    done

    if [ "$ROLLBACK_OK" = false ]; then
      echo "==> CRITICAL: Rollback also failed. Manual intervention required."
    fi
  else
    echo "==> No previous version to rollback to. Manual intervention required."
  fi

  exit 1
fi

# ── Backfill PostgreSQL search index from the old search collection ─────────
if [ "$RUN_SEARCH_BACKFILL" = "1" ]; then
  LEGACY_URL_KEY="TYPE""SENSE_URL"
  LEGACY_KEY_KEY="TYPE""SENSE_API_KEY"
  if ! grep -q "^${LEGACY_URL_KEY}=" "$ENV_FILE" 2>/dev/null && ! grep -q '^LEGACY_SEARCH_URL=' "$ENV_FILE" 2>/dev/null; then
    echo "==> Legacy search URL is missing from .env.prod; cannot backfill existing search data"
    echo "==> Set LEGACY_SEARCH_URL to the old search service or rerun with RUN_SEARCH_BACKFILL=0 if this is intentional"
    exit 1
  fi

  LEGACY_EXPORT_ENV=()
  if grep -q "^${LEGACY_URL_KEY}=" "$ENV_FILE" 2>/dev/null; then
    LEGACY_EXPORT_ENV+=(-e "LEGACY_SEARCH_URL=$(grep "^${LEGACY_URL_KEY}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)")
  fi
  if grep -q "^${LEGACY_KEY_KEY}=" "$ENV_FILE" 2>/dev/null; then
    LEGACY_EXPORT_ENV+=(-e "LEGACY_SEARCH_API_KEY=$(grep "^${LEGACY_KEY_KEY}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)")
  fi

  echo "==> Backfilling PostgreSQL search index from legacy search"
  (
    "${COMPOSE[@]}" exec -T "${LEGACY_EXPORT_ENV[@]}" api node apps/api/scripts/backfill-pg-search-from-legacy-index.js
  ) &
  BACKFILL_PID=$!
  if ! wait_with_heartbeat "$BACKFILL_PID" "Search index backfill"; then
    echo "==> Search index backfill failed"
    if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
      echo "==> ROLLING BACK API to ${PREV_TAG}; PostgreSQL backup remains at ${DB_BACKUP}"
      sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"
      "${COMPOSE[@]}" up -d --no-deps api
    fi
    exit 1
  fi

  echo "==> Verifying API after search backfill before removing legacy search data"
  POST_BACKFILL_RESPONSE=$(check_health)
  if [ -z "$POST_BACKFILL_RESPONSE" ]; then
    echo "==> API is not healthy after search backfill; keeping legacy search data for recovery"
    exit 1
  fi
  echo "==> Post-backfill health check passed: $POST_BACKFILL_RESPONSE"

  if [ "$REMOVE_LEGACY_SEARCH_AFTER_BACKFILL" = "1" ]; then
    remove_legacy_search_storage
  fi
else
  echo "==> Skipping search index backfill because RUN_SEARCH_BACKFILL=${RUN_SEARCH_BACKFILL}"
fi

# ── Clean up unused Docker objects after successful deployment ───────────────
# The VPS has limited disk and app images/build caches are large. This runs only
# after health checks and search backfill pass. Docker keeps objects used by
# running containers.
cleanup_docker_host "post-success"

echo "==> Deployed: ${IMAGE_TAG}"
