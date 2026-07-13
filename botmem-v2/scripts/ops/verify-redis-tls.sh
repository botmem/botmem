#!/bin/bash
set -euo pipefail

: "${REDIS_URL:?REDIS_URL is required}"
: "${REDIS_CA_FILE:?REDIS_CA_FILE is required}"
[[ "$REDIS_URL" == rediss://* ]] || {
  echo "REDIS_URL must use rediss://" >&2
  exit 2
}
[[ -r "$REDIS_CA_FILE" ]] || {
  echo "REDIS_CA_FILE is not readable" >&2
  exit 2
}

KEY="botmem:v2:restore-probe:$(openssl rand -hex 16)"
trap 'redis-cli --tls --cacert "$REDIS_CA_FILE" -u "$REDIS_URL" DEL "$KEY" >/dev/null 2>&1 || true' EXIT
redis-cli --tls --cacert "$REDIS_CA_FILE" -u "$REDIS_URL" PING | grep -qx PONG
redis-cli --tls --cacert "$REDIS_CA_FILE" -u "$REDIS_URL" SET "$KEY" probe EX 30 NX | grep -qx OK
redis-cli --tls --cacert "$REDIS_CA_FILE" -u "$REDIS_URL" GET "$KEY" | grep -qx probe
TTL="$(redis-cli --tls --cacert "$REDIS_CA_FILE" -u "$REDIS_URL" TTL "$KEY")"
[[ "$TTL" -gt 0 && "$TTL" -le 30 ]]
echo "Redis TLS and TTL probe passed"
