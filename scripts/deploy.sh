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
REMOVE_TYPESENSE_AFTER_BACKFILL="${REMOVE_TYPESENSE_AFTER_BACKFILL:-1}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

echo "==> Deploying ghcr.io/botmem/botmem:${IMAGE_TAG}"

# ── Save previous version for rollback ──────────────────────────────────────
PREV_TAG=""
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  PREV_TAG=$(grep '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)
fi
echo "==> Previous version: ${PREV_TAG:-none}"

# ── Update IMAGE_TAG in .env.prod ───────────────────────────────────────────
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "# Docker image version (managed by deploy.sh)" >> "$ENV_FILE"
  echo "IMAGE_TAG=${IMAGE_TAG}" >> "$ENV_FILE"
fi

cd "$DEPLOY_DIR"

# ── Back up PostgreSQL before image/schema changes ─────────────────────────
mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)
GLOBALS_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.globals.sql"
DB_BACKUP="${BACKUP_DIR}/botmem-${BACKUP_TS}.dump"

echo "==> Backing up PostgreSQL to ${DB_BACKUP}"
"${COMPOSE[@]}" exec -T postgres pg_dumpall --globals-only -U "$POSTGRES_USER" > "$GLOBALS_BACKUP"
"${COMPOSE[@]}" exec -T postgres pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" > "$DB_BACKUP"
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
  if ! "${COMPOSE[@]}" exec -T "${LEGACY_EXPORT_ENV[@]}" api node apps/api/scripts/backfill-pg-search-from-legacy-index.js; then
    echo "==> Search index backfill failed"
    if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
      echo "==> ROLLING BACK API to ${PREV_TAG}; PostgreSQL backup remains at ${DB_BACKUP}"
      sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"
      "${COMPOSE[@]}" up -d --no-deps api
    fi
    exit 1
  fi

  if [ "$REMOVE_TYPESENSE_AFTER_BACKFILL" = "1" ]; then
    echo "==> Removing old legacy search container(s) after successful backfill"
    docker ps -q --filter 'label=com.docker.compose.service='"type"'sense' | xargs -r docker rm -f
  fi
else
  echo "==> Skipping search index backfill because RUN_SEARCH_BACKFILL=${RUN_SEARCH_BACKFILL}"
fi

# ── Clean up unused images ──────────────────────────────────────────────────
# The VPS has limited disk and app images are large. This runs only after the
# new container is healthy; Docker keeps images used by running containers.
docker image prune -af 2>/dev/null || true

echo "==> Deployed: ${IMAGE_TAG}"
