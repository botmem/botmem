#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <selfhosted|managed>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/preflight.sh" "$MODE"

EXTRA_ARGS=()

case "$MODE" in
  selfhosted)
    ROOT="${BOTMEM_E2E_SELF_ROOT:-/tmp/botmem-e2e-selfhosted}"
    PROJECT="botmem_e2e_selfhosted"
    APP_PORT="22412"
    if [[ "${BOTMEM_E2E_USE_HOST_OLLAMA:-1}" == "1" ]]; then
      EXTRA_ARGS=()
    else
      EXTRA_ARGS=(--profile ollama)
    fi
    ;;
  managed)
    ROOT="${BOTMEM_E2E_MANAGED_ROOT:-/tmp/botmem-e2e-managed}"
    PROJECT="botmem_e2e_managed"
    APP_PORT="32412"
    EXTRA_ARGS=()
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

{
  echo "[$(date -u +%FT%TZ)] Starting $PROJECT"
  docker compose -p "$PROJECT" -f "$COMPOSE" --env-file "$ENV_FILE" ${EXTRA_ARGS:+"${EXTRA_ARGS[@]}"} up -d --build --wait
  echo "[$(date -u +%FT%TZ)] Started"
} | tee "$ART_DIR/up-${MODE}.log"

# Basic API reachability checks
{
  echo "Checking /api/version"
  curl -fsS "http://localhost:${APP_PORT}/api/version"
  echo
  echo "Checking /api/health"
  curl -fsS "http://localhost:${APP_PORT}/api/health"
  echo
} | tee "$ART_DIR/health-${MODE}.log"

bash "$SCRIPT_DIR/check-isolation.sh" "$MODE" | tee "$ART_DIR/isolation-${MODE}.log"

echo "Mode $MODE is up. Endpoint: http://localhost:${APP_PORT}"
