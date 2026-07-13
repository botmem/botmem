#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for script in "$root"/*.sh; do bash -n "$script"; done
sh -n "$root/postgres-entrypoint.sh"
sh -n "$root/redis-entrypoint.sh"

"$root/init-secrets.sh" --local-fixture "$work/secrets" >/dev/null
"$root/health-recover.test.sh"
"$root/wait-service-health.test.sh"
awk -v secrets="$work/secrets" '
  /^BOTMEM_V2_SECRETS_DIR=/ { print "BOTMEM_V2_SECRETS_DIR=" secrets; next }
  { print }
' "$root/config.env.example" > "$work/config.env"
cp "$root/release.env.example" "$work/release.env"
chmod 0600 "$work/config.env" "$work/release.env"
"$root/validate-release.sh" "$work/config.env" "$work/release.env"

docker compose --project-name botmem-v2-canary-validation \
  --env-file "$work/config.env" --env-file "$work/release.env" \
  -f "$root/compose.yaml" -f "$root/canary.override.yaml" config --quiet

if rg -n -i 'ssh-keyscan|StrictHostKeyChecking[ =]+no' \
  "$root/../../docs/production-operations.md" \
  "$root/../../../.github/workflows/botmem-v2-ci.yml" \
  "$root/../../../.github/workflows/botmem-v2-deploy.yml" \
  "$root/../../../.github/workflows/botmem-v2-backup.yml" 2>/dev/null; then
  echo 'local validation: forbidden SSH trust weakening found' >&2
  exit 1
fi

grep -Fq 'Strict-Transport-Security "max-age=31536000"' "$root/Caddyfile" \
  || { echo 'local validation: public edge HSTS policy is missing' >&2; exit 1; }
grep -Fq -- '--profile edge run --rm caddy-volume-init' "$root/deploy.sh" \
  || { echo 'local validation: edge activation does not initialize Caddy volumes' >&2; exit 1; }

for unit in botmem-v2-backup.service botmem-v2-backup.timer \
  botmem-v2-health-recover.service botmem-v2-health-recover.timer; do
  [[ -s "$root/$unit" ]] || { echo "local validation: missing systemd unit $unit" >&2; exit 1; }
done

echo 'local validation: scripts, operations units, stable Compose, and canary Compose passed'
