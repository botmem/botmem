#!/usr/bin/env bash
# Deploy Botmem API with minimal downtime
#
# Usage: deploy.sh <image-tag>
#
# Pulls the new image, then recreates only the API container.
# With health checks + restart: unless-stopped, the gap is ~5-10 seconds.
#
# Rollback: deploy.sh <previous-tag>

set -euo pipefail

IMAGE_TAG="${1:?Usage: deploy.sh <image-tag>}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/botmem}"
ENV_FILE="${DEPLOY_DIR}/.env.prod"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

echo "==> Deploying ghcr.io/botmem/botmem:${IMAGE_TAG}"

# Update IMAGE_TAG in .env.prod
if grep -q '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "# Docker image version (managed by deploy.sh)" >> "$ENV_FILE"
  echo "IMAGE_TAG=${IMAGE_TAG}" >> "$ENV_FILE"
fi

cd "$DEPLOY_DIR"

# Pull new image
docker pull "ghcr.io/botmem/botmem:${IMAGE_TAG}"

# Recreate only the API container (infra stays running)
docker compose -f "$COMPOSE_FILE" up -d --no-deps api

# Clean up old images
docker image prune -af --filter "until=24h" 2>/dev/null || true

echo "==> Deployed: ${IMAGE_TAG}"
