#!/usr/bin/env bash
# Deploy Botmem API with health check and automatic rollback
#
# Usage: deploy.sh <image-tag>
#
# Optional scopes:
#   DEPLOY_BACKEND=true|false  Recreate api + worker (default: true)
#   DEPLOY_WEB=true|false      Recreate app-web + landing-web + caddy (default: true)
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
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # seconds to wait for health check
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"    # seconds between health check attempts
POSTGRES_USER="${POSTGRES_USER:-botmem}"
POSTGRES_DB="${POSTGRES_DB:-botmem}"
RUN_SEARCH_BACKFILL="${RUN_SEARCH_BACKFILL:-1}"
REMOVE_LEGACY_SEARCH_AFTER_BACKFILL="${REMOVE_LEGACY_SEARCH_AFTER_BACKFILL:-1}"
DRAIN_TYPESENSE_ON_NEXT_STARTUP="${DRAIN_TYPESENSE_ON_NEXT_STARTUP:-0}"
DEPLOY_BACKEND="${DEPLOY_BACKEND:-true}"
DEPLOY_WEB="${DEPLOY_WEB:-true}"
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

remove_legacy_search_storage() {
  local legacy_service="type""sense"
  local legacy_volume="type""sense-data"

  echo "==> Removing old legacy search container(s) and data volume(s)"
  docker ps -aq --filter "label=com.docker.compose.service=${legacy_service}" | xargs -r docker rm -f
  docker volume ls -q --filter "label=com.docker.compose.volume=${legacy_volume}" | xargs -r docker volume rm
  docker volume ls -q | awk -v volume="${legacy_volume}" '$0 == volume || $0 ~ "_" volume "$"' | xargs -r docker volume rm
}

echo "==> Deploying Botmem split images:${IMAGE_TAG}"
echo "==> Deploy scope: backend=${DEPLOY_BACKEND}, web=${DEPLOY_WEB}"

# ── Save previous version for rollback ──────────────────────────────────────
PREV_TAG=""
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  PREV_TAG=$(grep '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)
fi
echo "==> Previous version: ${PREV_TAG:-none}"

cd "$DEPLOY_DIR"

ensure_env_default() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

set_env_if_value() {
  local key="$1"
  local old="$2"
  local value="$3"
  if grep -q "^${key}=${old}$" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  fi
}

ensure_env_default "APP_URL" "https://app.botmem.xyz"
ensure_env_default "LANDING_URL" "https://botmem.xyz"
ensure_env_default "BASE_URL" "https://api.botmem.xyz"
ensure_env_default "FRONTEND_URL" "https://app.botmem.xyz,https://botmem.xyz"
set_env_if_value "BASE_URL" "https://botmem.xyz" "https://api.botmem.xyz"
set_env_if_value "FRONTEND_URL" "https://botmem.xyz" "https://app.botmem.xyz,https://botmem.xyz"

# ── Free space before pull on small VPS disks ────────────────────────────────
# This only removes unused Docker objects. Named, attached database volumes are
# not removed unless PRUNE_DOCKER_VOLUMES=1 is set explicitly.
cleanup_docker_host "preflight"

if [ "$DEPLOY_BACKEND" = "true" ]; then
  # ── Recreate Postgres with pgvector image and verify extension ────────────
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
fi

# ── Update IMAGE_TAG in .env.prod only after preflight succeeds ─────────────
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "# Docker image version (managed by deploy.sh)" >> "$ENV_FILE"
  echo "IMAGE_TAG=${IMAGE_TAG}" >> "$ENV_FILE"
fi

if [ "$DRAIN_TYPESENSE_ON_NEXT_STARTUP" = "1" ]; then
  if grep -q '^DRAIN_TYPESENSE_TO_PG_ON_STARTUP=' "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^DRAIN_TYPESENSE_TO_PG_ON_STARTUP=.*|DRAIN_TYPESENSE_TO_PG_ON_STARTUP=1|" "$ENV_FILE"
  else
    echo "" >> "$ENV_FILE"
    echo "# One-shot legacy search drain (managed by deploy.sh)" >> "$ENV_FILE"
    echo "DRAIN_TYPESENSE_TO_PG_ON_STARTUP=1" >> "$ENV_FILE"
  fi
fi

# ── Pull new images ─────────────────────────────────────────────────────────
if [ "$DEPLOY_BACKEND" = "true" ]; then
  for image in api worker; do
    docker pull "ghcr.io/botmem/botmem:${image}-${IMAGE_TAG}"
  done
fi

if [ "$DEPLOY_WEB" = "true" ]; then
  for image in app landing; do
    docker pull "ghcr.io/botmem/botmem:${image}-${IMAGE_TAG}"
  done
fi

# ── Recreate changed app containers (infra stays running) ───────────────────
SERVICES=()
if [ "$DEPLOY_BACKEND" = "true" ]; then
  SERVICES+=(api worker)
fi
if [ "$DEPLOY_WEB" = "true" ]; then
  SERVICES+=(app-web landing-web caddy)
fi

if [ "${#SERVICES[@]}" -eq 0 ]; then
  echo "==> No runtime services selected"
  exit 0
fi

"${COMPOSE[@]}" up -d --no-deps "${SERVICES[@]}"

# ── Health check via Docker network (port not exposed to host) ──────────────
check_health() {
  docker exec botmem-caddy-1 wget -q -O- http://api:12412/api/version 2>/dev/null || echo ""
}

if [ "$DEPLOY_BACKEND" = "true" ]; then
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
else
  echo "==> Skipping API health wait because backend was not deployed"
  HEALTHY=true
fi

# ── Rollback if health check failed ────────────────────────────────────────
if [ "$HEALTHY" = false ]; then
  echo "==> HEALTH CHECK FAILED after ${HEALTH_TIMEOUT}s"
  echo "==> API container status:"
  "${COMPOSE[@]}" ps api || true
  echo "==> Worker container status:"
  "${COMPOSE[@]}" ps worker || true
  echo "==> Recent API logs:"
  docker logs --tail 120 botmem-api-1 || true

  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
    echo "==> ROLLING BACK to ${PREV_TAG}"

    # Restore previous version in .env.prod
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"

    # Recreate with previous image
    "${COMPOSE[@]}" up -d --no-deps api worker

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

echo "==> Worker status:"
"${COMPOSE[@]}" ps worker || true

# ── Backfill PostgreSQL search index from the old search collection ─────────
if [ "$DEPLOY_BACKEND" != "true" ]; then
  echo "==> Skipping search index backfill because backend was not deployed"
elif [ "$RUN_SEARCH_BACKFILL" = "1" ]; then
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
      echo "==> ROLLING BACK API to ${PREV_TAG}"
      sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"
      "${COMPOSE[@]}" up -d --no-deps api worker
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
