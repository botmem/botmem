#!/bin/bash
set -euo pipefail

umask 077

usage() {
  echo 'usage: init-secrets.sh [--local-fixture] SECRETS_DIRECTORY' >&2
  exit 64
}

fixture=false
if [[ "${1:-}" == '--local-fixture' ]]; then
  fixture=true
  shift
fi
[[ $# -eq 1 && -n "$1" ]] || usage
root="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$root/database" "$root/tls"
chmod 0700 "$root" "$root/database" "$root/tls"

write_new() {
  local path="$1" value="$2"
  if [[ ! -e "$path" ]]; then
    printf '%s\n' "$value" > "$path"
    chmod 0600 "$path"
  fi
}

random_base64url() {
  openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '='
}

write_new "$root/postgres-admin-password" "$(random_base64url)"
for name in api sync projection-worker projection-dispatcher commerce identity-admin lifecycle migrator; do
  write_new "$root/database/$name-password" "$(random_base64url)"
done

if [[ -e "$root/tls/ca.crt" || -e "$root/tls/ca.key" ]]; then
  [[ -f "$root/tls/ca.crt" && -f "$root/tls/ca.key" ]] \
    || { echo 'partial internal CA state; restore the missing file instead of rotating implicitly' >&2; exit 78; }
fi
write_new "$root/redis-password" "$(random_base64url)"
write_new "$root/auth-token-pepper" "$(random_base64url)"
write_new "$root/connector-vault-keys" "1:$(random_base64url)"
write_new "$root/lifecycle-artifact-key" "$(random_base64url)"

if [[ ! -f "$root/tls/ca.crt" || ! -f "$root/tls/ca.key" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj '/CN=Botmem v2 internal CA' \
    -keyout "$root/tls/ca.key" -out "$root/tls/ca.crt" >/dev/null 2>&1
fi
for service in postgres redis; do
  if [[ -e "$root/tls/$service.crt" || -e "$root/tls/$service.key" ]]; then
    [[ -f "$root/tls/$service.crt" && -f "$root/tls/$service.key" ]] \
      || { echo "partial $service TLS state; restore the missing file instead of rotating implicitly" >&2; exit 78; }
  fi
  if [[ ! -f "$root/tls/$service.crt" || ! -f "$root/tls/$service.key" ]]; then
    openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$service" \
      -addext "subjectAltName=DNS:$service" \
      -keyout "$root/tls/$service.key" -out "$root/tls/$service.csr" >/dev/null 2>&1
    openssl x509 -req -sha256 -days 825 \
      -in "$root/tls/$service.csr" -CA "$root/tls/ca.crt" -CAkey "$root/tls/ca.key" \
      -CAcreateserial -copy_extensions copy \
      -out "$root/tls/$service.crt" >/dev/null 2>&1
    rm -f "$root/tls/$service.csr" "$root/tls/ca.srl"
  fi
done
find "$root" -type f -exec chmod 0600 {} +

admin_password="$(<"$root/postgres-admin-password")"
login_for() {
  case "$1" in
    api) echo botmem_v2_api_login ;;
    sync) echo botmem_v2_sync_login ;;
    projection-worker) echo botmem_v2_projection_login ;;
    projection-dispatcher) echo botmem_v2_dispatcher_login ;;
    commerce) echo botmem_v2_commerce_login ;;
    identity-admin) echo botmem_v2_identity_admin_login ;;
    lifecycle) echo botmem_v2_lifecycle_login ;;
    migrator) echo botmem_v2_migrator_login ;;
    *) return 1 ;;
  esac
}
write_new "$root/postgres-admin-database-url" \
  "postgresql://postgres:${admin_password}@postgres:5432/botmem_v2?sslmode=verify-full"
for name in api sync projection-worker projection-dispatcher commerce identity-admin lifecycle migrator; do
  password="$(<"$root/database/$name-password")"
  if [[ "$name" == migrator ]]; then
    write_new "$root/migrator-database-url" \
      'postgresql://botmem_v2_migrator_login@postgres:5432/botmem_v2?sslmode=verify-full&sslrootcert=%2Frun%2Fsecrets%2Finternal_ca_crt'
  else
    write_new "$root/$name-database-url" \
      "postgresql://$(login_for "$name"):${password}@postgres:5432/botmem_v2?sslmode=verify-full"
  fi
done
redis_password="$(<"$root/redis-password")"
write_new "$root/redis-url" "rediss://:${redis_password}@redis:6379"

external=(
  google-oauth-client-secret microsoft-oauth-client-secret openai-api-key
  resend-api-key stripe-checkout-api-key stripe-webhook-secret
  stripe-reconciler-api-key backup-age-recipient backup-age-identity
)
for name in "${external[@]}"; do
  if [[ "$fixture" == true ]]; then
    if [[ "$name" == backup-age-recipient ]]; then
      # The fixture is syntactically nonempty; local Compose validation never decrypts.
      write_new "$root/$name" 'age1localfixture000000000000000000000000000000000000000000000000000'
    else
      write_new "$root/$name" "local-fixture-$name"
    fi
  elif [[ ! -e "$root/$name" ]]; then
    install -m 0600 /dev/null "$root/$name"
  fi
done

# Standalone Compose file secrets are bind mounts, so uid/mode declarations are
# not applied. Production Node processes run as uid 1000 and receive only
# the exact files they need, owned by that uid and unreadable to group/other.
runtime_readable=(
  api-database-url sync-database-url projection-worker-database-url
  projection-dispatcher-database-url commerce-database-url
  identity-admin-database-url lifecycle-database-url migrator-database-url
  auth-token-pepper connector-vault-keys google-oauth-client-secret
  microsoft-oauth-client-secret openai-api-key resend-api-key redis-url
  stripe-checkout-api-key stripe-webhook-secret stripe-reconciler-api-key
  lifecycle-artifact-key tls/ca.crt database/migrator-password
)
if [[ "$(id -u)" == 0 ]]; then
  for name in "${runtime_readable[@]}"; do
    chown 1000:1000 "$root/$name"
    chmod 0400 "$root/$name"
  done
elif [[ "$fixture" != true ]]; then
  echo 'production secret initialization must run as root to set container-readable ownership' >&2
  exit 77
fi

echo "secret initialization complete at $root; provider and backup files must be provisioned before deployment"
