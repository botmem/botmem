#!/bin/bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { echo 'host bootstrap: root is required' >&2; exit 77; }
# The host-owned file is present on every supported Debian/Ubuntu target but is
# intentionally outside this repository, so ShellCheck cannot follow it.
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]] \
  || { echo 'host bootstrap: supported Ubuntu 22.04 or 24.04 is required' >&2; exit 78; }
[[ "$(uname -m)" == x86_64 ]] \
  || { echo 'host bootstrap: x86_64 is required' >&2; exit 78; }

if ! command -v age >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -o Acquire::Retries=3
  apt-get install --yes --no-install-recommends age
fi
age --version | grep -Eq '^v?[0-9]+\.[0-9]+'

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$root/verify-image-signature.sh" --self-test >/dev/null
echo 'host bootstrap: age and digest-pinned signature verifier are ready'
