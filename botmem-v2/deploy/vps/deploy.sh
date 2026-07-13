#!/bin/bash
set -euo pipefail

umask 077

command -v flock >/dev/null || { echo 'deploy: flock is required' >&2; exit 69; }
operation_lock="${BOTMEM_V2_OPERATION_LOCK:-/run/lock/botmem-v2-operation.lock}"
mkdir -p "$(dirname "$operation_lock")"
exec 9>"$operation_lock"
flock -n 9 || { echo 'deploy: another deployment or recovery operation is active' >&2; exit 75; }

usage() {
  echo 'usage: deploy.sh INSTALL_ROOT RELEASE_ID CANDIDATE_RELEASE_ENV [--activate-edge]' >&2
  exit 64
}

[[ $# -ge 3 && $# -le 4 ]] || usage
install_root="$1"
release_id="$2"
candidate_env="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
activate_edge=false
if [[ "${4:-}" == '--activate-edge' ]]; then activate_edge=true; elif [[ $# -eq 4 ]]; then usage; fi
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] \
  || { echo 'deploy: release ID must be a full Git commit SHA' >&2; exit 78; }

assets="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_env="$install_root/config.env"
secrets_dir="$(sed -n 's/^BOTMEM_V2_SECRETS_DIR=//p' "$config_env" 2>/dev/null || true)"
[[ -n "$secrets_dir" ]] || { echo 'deploy: persistent config.env is absent or invalid' >&2; exit 78; }

"$assets/preflight-host.sh"
"$assets/verify-secrets.sh" "$secrets_dir"
"$assets/validate-release.sh" --verify-signatures "$config_env" "$candidate_env"

config_value() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$config_env")"
  [[ -n "$value" ]] || { echo "deploy: $key is missing" >&2; exit 78; }
  printf '%s' "$value"
}

api_port="$(config_value BOTMEM_V2_API_LOOPBACK_PORT)"
web_port="$(config_value BOTMEM_V2_WEB_LOOPBACK_PORT)"
canary_api_port="$(config_value BOTMEM_V2_CANARY_API_PORT)"
canary_web_port="$(config_value BOTMEM_V2_CANARY_WEB_PORT)"
for port in "$api_port" "$web_port" "$canary_api_port" "$canary_web_port"; do
  [[ "$port" =~ ^[0-9]{2,5}$ && "$port" -le 65535 ]] \
    || { echo 'deploy: loopback port configuration is invalid' >&2; exit 78; }
done

compose=(docker compose --project-name botmem-v2 --env-file "$config_env" --env-file "$candidate_env" -f "$assets/compose.yaml")
canary_project="botmem-v2-canary-${release_id:0:12}"
canary=(docker compose --project-name "$canary_project" --env-file "$config_env" --env-file "$candidate_env" -f "$assets/compose.yaml" -f "$assets/canary.override.yaml")
previous_assets="$(readlink -f "$install_root/current" 2>/dev/null || true)"
previous_env="$(readlink -f "$install_root/release.env" 2>/dev/null || true)"
promotion_started=false
canary_started=false
success=false

rollback() {
  status=$?
  if [[ "$success" == true ]]; then return; fi
  set +e
  if [[ "$canary_started" == true ]]; then
    "${canary[@]}" down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1
  fi
  if [[ "$promotion_started" == true ]]; then
    if [[ -n "$previous_assets" && -f "$previous_assets/compose.yaml" && -n "$previous_env" && -f "$previous_env" ]]; then
      previous=(docker compose --project-name botmem-v2 --env-file "$config_env" --env-file "$previous_env" -f "$previous_assets/compose.yaml")
      "${previous[@]}" up -d --no-deps \
        sync-worker projection-worker commerce-reconciler lifecycle-worker api web
      "$previous_assets/smoke.sh" "$api_port" "$web_port"
    else
      "${compose[@]}" stop api web sync-worker projection-worker commerce-reconciler lifecycle-worker
    fi
  fi
  echo "deploy: release $release_id failed; prior release environment restored" >&2
  exit "$status"
}
trap rollback EXIT INT TERM

for service in migrator api sync-worker projection-worker commerce-reconciler lifecycle-worker web; do
  "${compose[@]}" --profile tools pull "$service"
done
"${compose[@]}" up -d postgres redis
"${compose[@]}" --profile tools run --rm role-bootstrap

has_existing_tables="$("${compose[@]}" exec -T postgres psql -U postgres -d botmem_v2 -X -Atc \
  "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'botmem')")"
if [[ "$has_existing_tables" == t ]]; then
  "$assets/backup-and-restore.sh" "$config_env" "$candidate_env"
fi
"${compose[@]}" --profile tools run --rm migrator
if [[ "$has_existing_tables" != t ]]; then
  "$assets/backup-and-restore.sh" "$config_env" "$candidate_env"
fi

promotion_started=true
"${compose[@]}" run --rm lifecycle-volume-init
"${compose[@]}" up -d --no-deps \
  sync-worker projection-worker commerce-reconciler lifecycle-worker
projection_container="$("${compose[@]}" ps -q projection-worker)"
"$assets/wait-service-health.sh" "$projection_container" projection-worker 240

canary_started=true
"${canary[@]}" run --rm lifecycle-volume-init
"${canary[@]}" up -d --no-deps api web
"$assets/smoke.sh" "$canary_api_port" "$canary_web_port"
"${canary[@]}" down --volumes --remove-orphans --timeout 20
canary_started=false

"${compose[@]}" up -d --no-deps api web
"$assets/smoke.sh" "$api_port" "$web_port"

if [[ "$activate_edge" == true ]]; then
  [[ "${BOTMEM_V2_EDGE_CONFIRM:-}" == 'replace_public_botmem_edge' ]] \
    || { echo 'deploy: public edge activation requires BOTMEM_V2_EDGE_CONFIRM=replace_public_botmem_edge' >&2; exit 78; }
  "${compose[@]}" --profile edge pull caddy-volume-init caddy
  "${compose[@]}" --profile edge run --rm caddy-volume-init
  "${compose[@]}" --profile edge up -d --no-deps caddy
fi

"$assets/install-operations.sh"
mkdir -p "$install_root/releases"
ln -sfn "$assets" "$install_root/current.next"
mv -Tf "$install_root/current.next" "$install_root/current"
ln -sfn "$candidate_env" "$install_root/release.env.next"
mv -Tf "$install_root/release.env.next" "$install_root/release.env"
success=true
"${compose[@]}" ps
echo "deploy: release $release_id promoted after backup, restore, migration, and loopback canary"
