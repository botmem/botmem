#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXPECTED_TUNNEL="$ROOT/target/universal-apple-darwin/release/botmem-tunnel"
external_tunnel_override=false
if [[ -n "${BOTMEM_TUNNEL_EXECUTABLE:-}" && "$BOTMEM_TUNNEL_EXECUTABLE" != "$EXPECTED_TUNNEL" ]]; then
  external_tunnel_override=true
fi
workspace_tunnel_only=true
$external_tunnel_override && workspace_tunnel_only=false
BOTMEM_TUNNEL_EXECUTABLE="$EXPECTED_TUNNEL"

developer_env=false
developer_identity=false
notary_env=false
notary_credentials=false
version_valid=false
build_valid=false
tunnel_executable=false
tunnel_universal=false
rust_arm=false
rust_intel=false

if [[ -n "${DEVELOPER_ID_APPLICATION:-}" ]]; then
  developer_env=true
  if security find-identity -v -p codesigning 2>/dev/null \
      | grep -Fq "\"$DEVELOPER_ID_APPLICATION\""; then
    developer_identity=true
  fi
fi

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notary_env=true
  NOTARY_RESULT="$(mktemp)"
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" \
      --output-format json >"$NOTARY_RESULT" 2>/dev/null; then
    notary_credentials=true
  fi
  rm -f "$NOTARY_RESULT"
fi

if [[ "${BOTMEM_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  version_valid=true
fi
if [[ "${BOTMEM_BUILD_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
  build_valid=true
fi

if [[ "${BOTMEM_TUNNEL_EXECUTABLE:-}" = /* && -x "${BOTMEM_TUNNEL_EXECUTABLE:-}" ]]; then
  tunnel_executable=true
  TUNNEL_ARCHS="$(xcrun lipo -archs "$BOTMEM_TUNNEL_EXECUTABLE" 2>/dev/null || true)"
  if [[ "$TUNNEL_ARCHS" == "x86_64 arm64" || "$TUNNEL_ARCHS" == "arm64 x86_64" ]]; then
    tunnel_universal=true
  fi
fi

rustup target list --installed 2>/dev/null | grep -qx aarch64-apple-darwin && rust_arm=true
rustup target list --installed 2>/dev/null | grep -qx x86_64-apple-darwin && rust_intel=true

ok=false
if ! $external_tunnel_override \
    && $developer_env && $developer_identity && $notary_env && $notary_credentials \
    && $version_valid && $build_valid && $tunnel_executable && $tunnel_universal \
    && $rust_arm && $rust_intel; then
  ok=true
fi

cat <<JSON
{
  "schema": "botmem.macos.release-preflight.v1",
  "ok": $ok,
  "checks": {
    "developerIdEnvironment": $developer_env,
    "developerIdIdentityInstalled": $developer_identity,
    "notaryProfileEnvironment": $notary_env,
    "notaryCredentialsVerified": $notary_credentials,
    "workspaceTunnelOnly": $workspace_tunnel_only,
    "versionValid": $version_valid,
    "buildNumberValid": $build_valid,
    "tunnelExecutable": $tunnel_executable,
    "tunnelUniversal": $tunnel_universal,
    "rustArmTargetInstalled": $rust_arm,
    "rustIntelTargetInstalled": $rust_intel
  }
}
JSON

$ok
