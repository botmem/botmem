#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat >"$work/docker" <<'EOF'
#!/bin/bash
set -euo pipefail
echo "${BOTMEM_FAKE_CONTAINER_STATE:?}"
EOF
chmod +x "$work/docker"

BOTMEM_V2_DOCKER_BIN="$work/docker" BOTMEM_FAKE_CONTAINER_STATE='running healthy' \
  "$root/wait-service-health.sh" aaaaaaaaaaaa projection-worker 1 \
  | grep -qx 'service health: projection-worker is ready'

if BOTMEM_V2_DOCKER_BIN="$work/docker" BOTMEM_FAKE_CONTAINER_STATE='exited unhealthy' \
  "$root/wait-service-health.sh" aaaaaaaaaaaa projection-worker 1 >/dev/null 2>&1; then
  echo 'wait service health test: exited container unexpectedly passed' >&2
  exit 1
fi

if BOTMEM_V2_DOCKER_BIN="$work/docker" BOTMEM_FAKE_CONTAINER_STATE='running healthy' \
  "$root/wait-service-health.sh" not-a-container projection-worker 1 >/dev/null 2>&1; then
  echo 'wait service health test: invalid container ID unexpectedly passed' >&2
  exit 1
fi

echo 'wait service health tests: healthy, stopped, and invalid identity paths passed'
