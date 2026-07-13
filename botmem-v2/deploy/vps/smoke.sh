#!/bin/bash
set -euo pipefail

api_port="${1:?API loopback port is required}"
web_port="${2:?Web loopback port is required}"
deadline=$((SECONDS + ${BOTMEM_SMOKE_TIMEOUT_SECONDS:-240}))
api="http://127.0.0.1:$api_port"
web="http://127.0.0.1:$web_port"

until curl --silent --show-error --fail --max-time 3 "$api/health/live" | grep -q '"status":"live"'; do
  (( SECONDS < deadline )) || { echo 'smoke: API liveness timed out' >&2; exit 1; }
  sleep 2
done
until curl --silent --show-error --fail --max-time 5 "$api/health/ready" | grep -q '"status":"ready"'; do
  (( SECONDS < deadline )) || { echo 'smoke: API readiness timed out' >&2; exit 1; }
  sleep 3
done
curl --silent --show-error --fail --max-time 5 "$web/" | grep -Eqi '<!doctype html|<html'

status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  "$api/v2/workspaces/00000000-0000-4000-8000-000000000000/lifecycle/jobs")"
[[ "$status" == 401 ]] \
  || { echo "smoke: lifecycle route must exist and reject anonymous access (received $status)" >&2; exit 1; }
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$api/v2/session")"
[[ "$status" == 401 ]] \
  || { echo "smoke: session route must reject anonymous access (received $status)" >&2; exit 1; }

echo 'smoke: liveness, readiness, Web, identity, and lifecycle boundaries passed'
