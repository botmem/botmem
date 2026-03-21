#!/usr/bin/env bash
# Zero-downtime deployment for Botmem via Docker Swarm
#
# Usage: deploy.sh <image-tag>
#
# Docker Swarm handles rolling updates automatically:
#   - Starts new container (order: start-first)
#   - Waits for health checks to pass
#   - Stops old container
#   - Rolls back automatically on failure
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

# Source env for compose variable substitution
# Use grep to extract only valid KEY=VALUE lines (skip multi-line JSON, comments, blanks)
set -a
eval "$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | grep -v '^#')" || true
set +a

# Pull new image
docker pull "ghcr.io/botmem/botmem:${IMAGE_TAG}"

# Deploy stack — Swarm detects image change and triggers rolling update
docker stack deploy -c "$COMPOSE_FILE" botmem

# Clean up old images
docker image prune -af --filter "until=24h" 2>/dev/null || true

echo "==> Stack deployed. Swarm is rolling out ${IMAGE_TAG}."
echo "    Monitor: docker service ps botmem_api"
