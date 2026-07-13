#!/bin/bash
set -euo pipefail

[[ "$(id -u)" == 0 || "${BOTMEM_V2_HEALTH_TEST_MODE:-}" == 1 ]] \
  || { echo 'health recovery: root is required' >&2; exit 77; }

install_root="${BOTMEM_V2_INSTALL_ROOT:-/opt/botmem-v2}"
assets="$(readlink -f "$install_root/current" 2>/dev/null || true)"
config_env="$install_root/config.env"
release_env="$(readlink -f "$install_root/release.env" 2>/dev/null || true)"
lock_file="${BOTMEM_V2_OPERATION_LOCK:-/run/lock/botmem-v2-operation.lock}"
docker_bin="${BOTMEM_V2_DOCKER_BIN:-docker}"
curl_bin="${BOTMEM_V2_CURL_BIN:-curl}"

if [[ -z "$assets" || ! -f "$assets/compose.yaml" || ! -f "$config_env" || -z "$release_env" || ! -f "$release_env" ]]; then
  echo 'health recovery: skipped_not_installed'
  exit 0
fi

mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo 'health recovery: skipped_operation_in_progress'
  exit 0
fi

compose=("$docker_bin" compose --project-name botmem-v2 --env-file "$config_env" --env-file "$release_env" -f "$assets/compose.yaml")
api_port="$(sed -n 's/^BOTMEM_V2_API_LOOPBACK_PORT=//p' "$config_env")"
web_port="$(sed -n 's/^BOTMEM_V2_WEB_LOOPBACK_PORT=//p' "$config_env")"
[[ "$api_port" =~ ^[0-9]{2,5}$ && "$api_port" -le 65535 ]] \
  || { echo 'health recovery: invalid_api_port' >&2; exit 78; }
[[ "$web_port" =~ ^[0-9]{2,5}$ && "$web_port" -le 65535 ]] \
  || { echo 'health recovery: invalid_web_port' >&2; exit 78; }

running_services="$("${compose[@]}" ps --status running --services 2>/dev/null || true)"
recovered=0

service_running() {
  grep -Fxq "$1" <<<"$running_services"
}

recover_service() {
  local service="$1" reason="$2"
  "${compose[@]}" up -d --no-deps "$service" >/dev/null
  echo "health recovery: recovered service=$service reason=$reason"
  recovered=1
}

restart_service() {
  local service="$1" reason="$2"
  "${compose[@]}" restart "$service" >/dev/null
  echo "health recovery: recovered service=$service reason=$reason"
  recovered=1
}

container_health() {
  local container_id
  container_id="$("${compose[@]}" ps -q "$1" 2>/dev/null || true)"
  [[ -n "$container_id" ]] || { echo missing; return; }
  "$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || echo missing
}

for service in sync-worker projection-worker commerce-reconciler lifecycle-worker api web; do
  if ! service_running "$service"; then
    recover_service "$service" not_running
  fi
done

projection_health="$(container_health projection-worker)"
if [[ "$projection_health" == unhealthy ]]; then
  restart_service projection-worker unhealthy
fi

api_health="$(container_health api)"
if [[ "$api_health" == unhealthy ]]; then
  readiness="$($curl_bin --silent --show-error --max-time 5 \
    "http://127.0.0.1:$api_port/health/ready" 2>/dev/null || true)"
  case "$readiness" in
    *'hosted_sync_unavailable'*) restart_service sync-worker stale_heartbeat ;;
    *'commerce_reconciler_unavailable'*) restart_service commerce-reconciler stale_heartbeat ;;
    *'lifecycle_unavailable'*) restart_service lifecycle-worker stale_heartbeat ;;
    *'device_relay_unavailable'*) restart_service api relay_dependency_stale ;;
    *'database_unavailable'*) echo 'health recovery: persistent_dependency_unavailable reason=database' >&2; exit 1 ;;
    *'login_delivery_unconfigured'*) echo 'health recovery: configuration_unavailable reason=login_delivery' >&2; exit 1 ;;
    *) restart_service api readiness_unknown ;;
  esac
fi

if ! "$curl_bin" --silent --show-error --fail --max-time 5 \
  "http://127.0.0.1:$web_port/" >/dev/null 2>&1; then
  restart_service web loopback_unavailable
fi

if (( recovered == 0 )); then
  echo 'health recovery: healthy'
fi
