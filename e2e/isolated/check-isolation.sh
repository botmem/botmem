#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <selfhosted|managed>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$MODE" in
  selfhosted)
    ROOT="${BOTMEM_E2E_SELF_ROOT:-/tmp/botmem-e2e-selfhosted}"
    PROJECT="botmem_e2e_selfhosted"
    ;;
  managed)
    ROOT="${BOTMEM_E2E_MANAGED_ROOT:-/tmp/botmem-e2e-managed}"
    PROJECT="botmem_e2e_managed"
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    exit 1
    ;;
esac

COMPOSE="$ROOT/docker-compose.yml"
ENV_FILE="$ROOT/.env"

# Verify compose resources are namespaced by project
CONTAINERS=$(docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$ENV_FILE" ps -q)
if [[ -z "$CONTAINERS" ]]; then
  echo "No running containers for $PROJECT" >&2
  exit 1
fi

# Ensure no bind mount from repo path is used by this e2e project
for c in $CONTAINERS; do
  if docker inspect "$c" | grep -q "$REPO_ROOT"; then
    echo "Isolation violation: container $c mounts repo path $REPO_ROOT" >&2
    exit 1
  fi

done

# Ensure compose dir itself lives outside repo root
case "$ROOT" in
  "$REPO_ROOT"* )
    echo "Isolation violation: root $ROOT is inside repo $REPO_ROOT" >&2
    exit 1
    ;;
esac

echo "Isolation check OK for $PROJECT"
