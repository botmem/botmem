#!/bin/bash
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo 'host preflight: Linux is required' >&2; exit 78; }
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo 'host preflight: Vultr production must be x86_64' >&2; exit 78 ;;
esac
command -v docker >/dev/null || { echo 'host preflight: Docker is required' >&2; exit 69; }
docker compose version >/dev/null || { echo 'host preflight: Docker Compose v2 is required' >&2; exit 69; }
command -v age >/dev/null || { echo 'host preflight: age is required' >&2; exit 69; }
command -v curl >/dev/null || { echo 'host preflight: curl is required' >&2; exit 69; }
command -v flock >/dev/null || { echo 'host preflight: flock is required' >&2; exit 69; }
docker_config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
[[ -s "$docker_config" ]] \
  || { echo 'host preflight: persistent read-only GHCR authentication is required' >&2; exit 78; }
grep -q 'ghcr.io' "$docker_config" \
  || { echo 'host preflight: Docker config has no persistent GHCR credential' >&2; exit 78; }

memory_bytes="$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)"
swap_bytes="$(awk '/^SwapTotal:/ {print $2 * 1024}' /proc/meminfo)"
available_bytes="$(df -PB1 /opt | awk 'NR == 2 {print $4}')"
(( memory_bytes >= 1500 * 1024 * 1024 )) \
  || { echo 'host preflight: at least 1500 MiB RAM is required' >&2; exit 78; }
(( swap_bytes >= 2048 * 1024 * 1024 )) \
  || { echo 'host preflight: at least 2 GiB swap is required on the current Vultr size' >&2; exit 78; }
(( available_bytes >= 8 * 1024 * 1024 * 1024 )) \
  || { echo 'host preflight: at least 8 GiB free under /opt is required' >&2; exit 78; }
docker info --format '{{.Architecture}}' | grep -Eq '^(x86_64|amd64)$' \
  || { echo 'host preflight: Docker daemon architecture is not amd64' >&2; exit 78; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$root/verify-image-signature.sh" --self-test >/dev/null

echo 'host preflight: Vultr amd64 resources, Docker, persistent GHCR auth, pinned signature verifier, age, and flock passed'
