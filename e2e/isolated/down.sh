#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <selfhosted|managed>" >&2
  exit 1
fi

REMOVE_VOLUMES="${BOTMEM_E2E_REMOVE_VOLUMES:-1}"

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
ART_DIR="$ROOT/artifacts"
mkdir -p "$ART_DIR"

ARGS=(-p "$PROJECT" -f "$COMPOSE" --env-file "$ENV_FILE" down --remove-orphans)
if [[ "$REMOVE_VOLUMES" == "1" ]]; then
  ARGS+=(--volumes)
fi

{
  echo "[$(date -u +%FT%TZ)] Stopping $PROJECT"
  docker compose "${ARGS[@]}"
  echo "[$(date -u +%FT%TZ)] Stopped"
} | tee "$ART_DIR/down-${MODE}.log"
