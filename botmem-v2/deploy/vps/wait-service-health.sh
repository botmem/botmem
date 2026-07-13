#!/bin/bash
set -euo pipefail

[[ $# -eq 3 ]] \
  || { echo 'usage: wait-service-health.sh CONTAINER_ID SERVICE TIMEOUT_SECONDS' >&2; exit 64; }
container_id="$1"
service="$2"
timeout_seconds="$3"
docker_bin="${BOTMEM_V2_DOCKER_BIN:-docker}"
[[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] \
  || { echo 'service health: invalid container ID' >&2; exit 78; }
[[ "$service" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] \
  || { echo 'service health: invalid service name' >&2; exit 78; }
[[ "$timeout_seconds" =~ ^[1-9][0-9]{0,3}$ && "$timeout_seconds" -le 900 ]] \
  || { echo 'service health: timeout must be between 1 and 900 seconds' >&2; exit 78; }

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  state="$($docker_bin inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$state" == 'running healthy' ]]; then
    echo "service health: $service is ready"
    exit 0
  fi
  if [[ "$state" == exited* || "$state" == dead* ]]; then
    echo "service health: $service stopped before becoming healthy" >&2
    exit 1
  fi
  sleep 2
done

echo "service health: $service did not become healthy before deadline" >&2
exit 1
