#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <selfhosted|managed>" >&2
  exit 1
fi

case "$MODE" in
  selfhosted)
    ROOT="${BOTMEM_E2E_SELF_ROOT:-/tmp/botmem-e2e-selfhosted}"
    PROJECT="botmem_e2e_selfhosted"
    APP_PORT="22412"
    ;;
  managed)
    ROOT="${BOTMEM_E2E_MANAGED_ROOT:-/tmp/botmem-e2e-managed}"
    PROJECT="botmem_e2e_managed"
    APP_PORT="32412"
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    exit 1
    ;;
esac

COMPOSE="$ROOT/docker-compose.yml"
ENV_FILE="$ROOT/.env"

[[ -f "$COMPOSE" ]] || { echo "Missing compose: $COMPOSE" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Missing env file: $ENV_FILE" >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin not available" >&2
  exit 1
fi

# Compose validity
( cd "$ROOT" && docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" config >/dev/null )

# Ensure target app port is free before start (best-effort check)
if lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | grep -q ":${APP_PORT} "; then
  echo "Port ${APP_PORT} already in use; pick another isolated mapping before starting." >&2
  exit 1
fi

echo "Preflight OK for mode=$MODE root=$ROOT project=$PROJECT"
