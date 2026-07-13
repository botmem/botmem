#!/bin/bash
set -euo pipefail

usage() {
  echo 'usage: validate-release.sh [--verify-signatures] CONFIG_ENV RELEASE_ENV' >&2
  exit 64
}

verify=false
if [[ "${1:-}" == '--verify-signatures' ]]; then
  verify=true
  shift
fi
[[ $# -eq 2 ]] || usage
config_env="$1"
release_env="$2"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for file in "$config_env" "$release_env"; do
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] \
    || { echo "release validation: $file is not a readable regular file" >&2; exit 78; }
done

env_value() {
  local file="$1" key="$2" count value
  count="$(grep -Ec "^${key}=" "$file" || true)"
  [[ "$count" == 1 ]] || { echo "release validation: $key must appear exactly once in $file" >&2; exit 78; }
  value="$(sed -n "s/^${key}=//p" "$file")"
  [[ -n "$value" && "$value" != *$'\r'* ]] \
    || { echo "release validation: $key is empty or malformed" >&2; exit 78; }
  printf '%s' "$value"
}

images=(
  BOTMEM_V2_API_IMAGE BOTMEM_V2_SYNC_WORKER_IMAGE
  BOTMEM_V2_PROJECTION_WORKER_IMAGE BOTMEM_V2_COMMERCE_RECONCILER_IMAGE
  BOTMEM_V2_LIFECYCLE_WORKER_IMAGE BOTMEM_V2_WEB_IMAGE BOTMEM_V2_MIGRATOR_IMAGE
  BOTMEM_V2_DATABASE_IMAGE BOTMEM_V2_EDGE_IMAGE
)
for key in "${images[@]}"; do
  reference="$(env_value "$release_env" "$key")"
  [[ "$reference" =~ ^[a-z0-9][a-z0-9._:/-]*/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
    || { echo "release validation: $key must be an immutable image@sha256 reference" >&2; exit 78; }
  if [[ "$verify" == true ]]; then
    : "${COSIGN_CERTIFICATE_IDENTITY:?exact certificate identity is required}"
    : "${COSIGN_CERTIFICATE_OIDC_ISSUER:=https://token.actions.githubusercontent.com}"
    "$root/verify-image-signature.sh" "$reference" >/dev/null
  fi
done

required_config=(
  BOTMEM_V2_SECRETS_DIR BOTMEM_PUBLIC_BASE_URL BOTMEM_PUBLIC_WEB_URL
  BOTMEM_TRUSTED_ORIGINS BOTMEM_LOGIN_EMAIL_FROM
  BOTMEM_MAC_DMG_URL BOTMEM_MAC_DMG_VERSION BOTMEM_MAC_DMG_SHA256
  BOTMEM_CLI_TGZ_URL BOTMEM_CLI_TGZ_VERSION BOTMEM_CLI_TGZ_SHA256
  BOTMEM_GOOGLE_OAUTH_CLIENT_ID BOTMEM_MICROSOFT_OAUTH_CLIENT_ID
  BOTMEM_STRIPE_API_VERSION BOTMEM_STRIPE_PRICE_ID
  BOTMEM_STRIPE_CHECKOUT_SUCCESS_URL BOTMEM_STRIPE_CHECKOUT_CANCEL_URL
  BOTMEM_STRIPE_PORTAL_RETURN_URL BOTMEM_TLS_CONTACT_EMAIL
)
for key in "${required_config[@]}"; do env_value "$config_env" "$key" >/dev/null; done

for key in BOTMEM_PUBLIC_BASE_URL BOTMEM_PUBLIC_WEB_URL \
  BOTMEM_MAC_DMG_URL BOTMEM_CLI_TGZ_URL \
  BOTMEM_STRIPE_CHECKOUT_SUCCESS_URL BOTMEM_STRIPE_CHECKOUT_CANCEL_URL \
  BOTMEM_STRIPE_PORTAL_RETURN_URL; do
  value="$(env_value "$config_env" "$key")"
  [[ "$value" == https://* && "$value" != *'@'* ]] \
    || { echo "release validation: $key must be a credential-free HTTPS URL" >&2; exit 78; }
done

mac_version="$(env_value "$config_env" BOTMEM_MAC_DMG_VERSION)"
cli_version="$(env_value "$config_env" BOTMEM_CLI_TGZ_VERSION)"
[[ "$mac_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ && "$cli_version" == "$mac_version" ]] \
  || { echo 'release validation: Mac and CLI versions must be the same semantic version' >&2; exit 78; }
[[ "$(env_value "$config_env" BOTMEM_MAC_DMG_SHA256)" =~ ^[0-9a-f]{64}$ \
   && "$(env_value "$config_env" BOTMEM_CLI_TGZ_SHA256)" =~ ^[0-9a-f]{64}$ ]] \
  || { echo 'release validation: artifact checksums must be lowercase SHA-256' >&2; exit 78; }

docker compose --project-name botmem-v2 \
  --env-file "$config_env" --env-file "$release_env" \
  -f "$root/compose.yaml" --profile tools --profile edge config --quiet
echo 'release validation: immutable references and Compose model passed'
