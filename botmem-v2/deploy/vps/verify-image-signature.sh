#!/bin/bash
set -euo pipefail

readonly verifier='ghcr.io/sigstore/cosign/cosign:v3.0.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00'
public_docker_config="$(mktemp -d)"
registry_docker_config="$(mktemp -d)"
trap 'rm -rf "$public_docker_config" "$registry_docker_config"' EXIT
docker_public=(docker --config "$public_docker_config")

if [[ "${1:-}" == '--self-test' && $# -eq 1 ]]; then
  "${docker_public[@]}" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    "$verifier" version | grep -Fq 'GitVersion:    v3.0.6'
  echo 'signature verifier: pinned cosign v3.0.6 is executable'
  exit 0
fi

[[ $# -eq 1 ]] || { echo 'usage: verify-image-signature.sh IMAGE@SHA256' >&2; exit 64; }
reference="$1"
[[ "$reference" =~ ^[a-z0-9][a-z0-9._:/-]*/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || { echo 'signature verifier: immutable image reference is required' >&2; exit 78; }
: "${COSIGN_CERTIFICATE_IDENTITY:?exact certificate identity is required}"
: "${COSIGN_CERTIFICATE_OIDC_ISSUER:=https://token.actions.githubusercontent.com}"
host_docker_config="${DOCKER_CONFIG:-${HOME:-/root}/.docker}/config.json"
[[ -f "$host_docker_config" && ! -L "$host_docker_config" && -s "$host_docker_config" ]] \
  || { echo 'signature verifier: persistent registry credential is unavailable' >&2; exit 78; }
install -m 0444 "$host_docker_config" "$registry_docker_config/config.json"

"${docker_public[@]}" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --tmpfs /home/nonroot:rw,noexec,nosuid,nodev,size=32m \
  --mount "type=bind,src=$registry_docker_config,dst=/docker-config,readonly" \
  --env DOCKER_CONFIG=/docker-config \
  "$verifier" verify \
  --certificate-identity "$COSIGN_CERTIFICATE_IDENTITY" \
  --certificate-oidc-issuer "$COSIGN_CERTIFICATE_OIDC_ISSUER" \
  "$reference"
