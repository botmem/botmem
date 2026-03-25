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
HEALTH_TIMEOUT=180   # seconds to wait for health check (NestJS can take 2+ min on 2GB VPS)
HEALTH_INTERVAL=5    # seconds between health check attempts

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

# ── Pull new image ──────────────────────────────────────────────────────────
docker pull "ghcr.io/botmem/botmem:${IMAGE_TAG}"

# ── Recreate only the API container (infra stays running) ───────────────────
docker compose -f "$COMPOSE_FILE" up -d --no-deps api

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

  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
    echo "==> ROLLING BACK to ${PREV_TAG}"

    # Restore previous version in .env.prod
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" "$ENV_FILE"

    # Recreate with previous image
    docker compose -f "$COMPOSE_FILE" up -d --no-deps api

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

# ── Clean up old images ─────────────────────────────────────────────────────
docker image prune -af --filter "until=24h" 2>/dev/null || true

echo "==> Deployed: ${IMAGE_TAG}"
