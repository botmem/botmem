#!/bin/bash
set -euo pipefail

file_mode() {
  local value
  if value="$(stat -c '%a' "$1" 2>/dev/null)"; then
    printf '%s' "$value"
    return
  fi
  stat -f '%Lp' "$1"
}

file_owner() {
  local value
  if value="$(stat -c '%u' "$1" 2>/dev/null)"; then
    printf '%s' "$value"
    return
  fi
  stat -f '%u' "$1"
}

if [[ "${1:-}" == '--self-test-stat' ]]; then
  probe="$(mktemp)"
  trap 'rm -f "$probe"' EXIT
  chmod 0600 "$probe"
  [[ "$(file_mode "$probe")" == 600 ]] \
    || { echo 'secret validation: portable file-mode probe failed' >&2; exit 1; }
  [[ "$(file_owner "$probe")" == "$(id -u)" ]] \
    || { echo 'secret validation: portable file-owner probe failed' >&2; exit 1; }
  echo 'secret validation: portable stat probes passed'
  exit 0
fi

root="${1:?secret directory is required}"
[[ -d "$root" && ! -L "$root" ]] || { echo 'secret directory must be a real directory' >&2; exit 78; }

required=(
  postgres-admin-password postgres-admin-database-url redis-password redis-url
  api-database-url sync-database-url projection-worker-database-url
  projection-dispatcher-database-url commerce-database-url
  identity-admin-database-url lifecycle-database-url migrator-database-url
  auth-token-pepper connector-vault-keys lifecycle-artifact-key
  google-oauth-client-secret microsoft-oauth-client-secret openai-api-key
  resend-api-key stripe-checkout-api-key stripe-webhook-secret
  stripe-reconciler-api-key backup-age-recipient backup-age-identity
  database/api-password database/sync-password database/projection-worker-password
  database/projection-dispatcher-password database/commerce-password
  database/identity-admin-password database/lifecycle-password database/migrator-password
  tls/ca.crt tls/ca.key tls/postgres.crt tls/postgres.key tls/redis.crt tls/redis.key
)

runtime_readable=(
  api-database-url sync-database-url projection-worker-database-url
  projection-dispatcher-database-url commerce-database-url
  identity-admin-database-url lifecycle-database-url migrator-database-url
  auth-token-pepper connector-vault-keys google-oauth-client-secret
  microsoft-oauth-client-secret openai-api-key resend-api-key redis-url
  stripe-checkout-api-key stripe-webhook-secret stripe-reconciler-api-key
  lifecycle-artifact-key tls/ca.crt database/migrator-password
)

for name in "${required[@]}"; do
  path="$root/$name"
  [[ -f "$path" && ! -L "$path" && -r "$path" && -s "$path" ]] \
    || { echo "secret validation: $name is missing, empty, unreadable, or a symlink" >&2; exit 78; }
  [[ "$(wc -c < "$path" | tr -d '[:space:]')" -le 65536 ]] \
    || { echo "secret validation: $name exceeds 64 KiB" >&2; exit 78; }
  permissions="$(file_mode "$path")"
  (( (8#$permissions & 077) == 0 )) \
    || { echo "secret validation: $name is accessible by group or other" >&2; exit 78; }
done

for name in "${runtime_readable[@]}"; do
  [[ "$(file_owner "$root/$name")" == 1000 ]] \
    || { echo "secret validation: $name must be owned by runtime uid 1000" >&2; exit 78; }
done

grep -Eq '^[A-Za-z0-9_-]{43}$' "$root/auth-token-pepper" \
  || { echo 'secret validation: auth token pepper is invalid' >&2; exit 78; }
grep -Eq '^1:[A-Za-z0-9_-]{43}(,[1-9][0-9]*:[A-Za-z0-9_-]{43})*$' "$root/connector-vault-keys" \
  || { echo 'secret validation: connector vault key ring is invalid' >&2; exit 78; }
grep -Eq '^[A-Za-z0-9_-]{43}$' "$root/lifecycle-artifact-key" \
  || { echo 'secret validation: lifecycle artifact key is invalid' >&2; exit 78; }
grep -Fqx 'postgresql://botmem_v2_migrator_login@postgres:5432/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt' \
  "$root/migrator-database-url" \
  || { echo 'secret validation: migrator database URL is invalid' >&2; exit 78; }
for name in postgres-admin api sync projection-worker projection-dispatcher commerce identity-admin lifecycle migrator; do
  password_path="$root/database/$name-password"
  [[ "$name" == postgres-admin ]] && password_path="$root/postgres-admin-password"
  grep -Eq '^[A-Za-z0-9_-]{32,128}$' "$password_path" \
    || { echo "secret validation: $name database password is invalid" >&2; exit 78; }
done
admin_password="$(<"$root/postgres-admin-password")"
[[ "$(<"$root/postgres-admin-database-url")" == "postgresql://postgres:${admin_password}@postgres:5432/botmem_v2?sslmode=verify-full" ]] \
  || { echo 'secret validation: PostgreSQL admin URL does not match its password' >&2; exit 78; }
login_for() {
  case "$1" in
    api) echo botmem_v2_api_login ;;
    sync) echo botmem_v2_sync_login ;;
    projection-worker) echo botmem_v2_projection_login ;;
    projection-dispatcher) echo botmem_v2_dispatcher_login ;;
    commerce) echo botmem_v2_commerce_login ;;
    identity-admin) echo botmem_v2_identity_admin_login ;;
    lifecycle) echo botmem_v2_lifecycle_login ;;
    *) return 1 ;;
  esac
}
for name in api sync projection-worker projection-dispatcher commerce identity-admin lifecycle; do
  password="$(<"$root/database/$name-password")"
  [[ "$(<"$root/$name-database-url")" == "postgresql://$(login_for "$name"):${password}@postgres:5432/botmem_v2?sslmode=verify-full" ]] \
    || { echo "secret validation: $name database URL does not match its password" >&2; exit 78; }
done
redis_password="$(<"$root/redis-password")"
[[ "$(<"$root/redis-url")" == "rediss://:${redis_password}@redis:6379" ]] \
  || { echo 'secret validation: Redis URL does not match its password' >&2; exit 78; }
openssl verify -CAfile "$root/tls/ca.crt" "$root/tls/postgres.crt" "$root/tls/redis.crt" >/dev/null
openssl x509 -in "$root/tls/postgres.crt" -checkhost postgres -noout >/dev/null
openssl x509 -in "$root/tls/redis.crt" -checkhost redis -noout >/dev/null
grep -q '^AGE-SECRET-KEY-' "$root/backup-age-identity" \
  || { echo 'secret validation: backup age identity is invalid' >&2; exit 78; }
grep -Eq '^age1[0-9a-z]+$' "$root/backup-age-recipient" \
  || { echo 'secret validation: backup age recipient is invalid' >&2; exit 78; }
command -v age-keygen >/dev/null \
  || { echo 'secret validation: age-keygen is required' >&2; exit 69; }
[[ "$(age-keygen -y "$root/backup-age-identity")" == "$(<"$root/backup-age-recipient")" ]] \
  || { echo 'secret validation: backup age identity does not match its recipient' >&2; exit 78; }

for service in postgres redis; do
  certificate_public="$(openssl x509 -in "$root/tls/$service.crt" -pubkey -noout | openssl sha256)"
  key_public="$(openssl pkey -in "$root/tls/$service.key" -pubout | openssl sha256)"
  [[ "$certificate_public" == "$key_public" ]] \
    || { echo "secret validation: $service certificate and key do not match" >&2; exit 78; }
done

echo 'secret validation: all required files and TLS identities passed'
