#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
install_root="$work/install"
mkdir -p "$install_root/assets" "$work/bin"
touch "$install_root/assets/compose.yaml" "$install_root/release-candidate.env"
ln -s "$install_root/assets" "$install_root/current"
ln -s "$install_root/release-candidate.env" "$install_root/release.env"
cat >"$install_root/config.env" <<'EOF'
BOTMEM_V2_API_LOOPBACK_PORT=22412
BOTMEM_V2_WEB_LOOPBACK_PORT=28080
EOF

cat >"$work/bin/docker" <<'EOF'
#!/bin/bash
set -euo pipefail
args=" $* "
last="${!#}"
case "$args" in
  *' ps --status running --services '*) printf '%s\n' ${BOTMEM_FAKE_RUNNING:?} ;;
  *' ps -q projection-worker '*) echo bbbbbbbbbbbb ;;
  *' ps -q '*) echo aaaaaaaaaaaa ;;
  *' inspect '*)
    if [[ "$last" == bbbbbbbbbbbb ]]; then echo "${BOTMEM_FAKE_PROJECTION_HEALTH:-healthy}"
    else echo "${BOTMEM_FAKE_API_HEALTH:-healthy}"
    fi
    ;;
  *' restart '*) echo "restart:$last" >>"${BOTMEM_FAKE_LOG:?}" ;;
  *' up -d --no-deps '*) echo "up:$last" >>"${BOTMEM_FAKE_LOG:?}" ;;
  *) echo "unexpected docker call: $*" >&2; exit 64 ;;
esac
EOF
cat >"$work/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
last="${!#}"
if [[ "$last" == */health/ready ]]; then
  printf '%s' "${BOTMEM_FAKE_READINESS:-{\"status\":\"ready\"}}"
  exit "${BOTMEM_FAKE_API_CURL_EXIT:-0}"
fi
exit "${BOTMEM_FAKE_WEB_EXIT:-0}"
EOF
cat >"$work/bin/flock" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$work/bin/docker" "$work/bin/curl" "$work/bin/flock"

all_services='sync-worker projection-worker commerce-reconciler lifecycle-worker api web'
run_recovery() {
  BOTMEM_V2_HEALTH_TEST_MODE=1 \
  BOTMEM_V2_INSTALL_ROOT="$install_root" \
  BOTMEM_V2_OPERATION_LOCK="$work/operation.lock" \
  BOTMEM_V2_DOCKER_BIN="$work/bin/docker" \
  BOTMEM_V2_CURL_BIN="$work/bin/curl" \
  PATH="$work/bin:$PATH" \
  BOTMEM_FAKE_RUNNING="$all_services" \
  BOTMEM_FAKE_LOG="$work/actions.log" \
  "$root/health-recover.sh"
}

: >"$work/actions.log"
run_recovery | grep -qx 'health recovery: healthy'
[[ ! -s "$work/actions.log" ]]

: >"$work/actions.log"
BOTMEM_FAKE_API_HEALTH=unhealthy \
BOTMEM_FAKE_READINESS='{"status":"not_ready","reason":"hosted_sync_unavailable"}' \
  run_recovery | grep -q 'service=sync-worker reason=stale_heartbeat'
grep -qx 'restart:sync-worker' "$work/actions.log"

: >"$work/actions.log"
BOTMEM_FAKE_PROJECTION_HEALTH=unhealthy BOTMEM_FAKE_WEB_EXIT=22 \
  run_recovery >/dev/null
grep -qx 'restart:projection-worker' "$work/actions.log"
grep -qx 'restart:web' "$work/actions.log"

: >"$work/actions.log"
BOTMEM_FAKE_RUNNING='sync-worker projection-worker commerce-reconciler lifecycle-worker api' \
BOTMEM_V2_HEALTH_TEST_MODE=1 \
BOTMEM_V2_INSTALL_ROOT="$install_root" \
BOTMEM_V2_OPERATION_LOCK="$work/operation.lock" \
BOTMEM_V2_DOCKER_BIN="$work/bin/docker" \
BOTMEM_V2_CURL_BIN="$work/bin/curl" \
PATH="$work/bin:$PATH" \
BOTMEM_FAKE_LOG="$work/actions.log" \
  "$root/health-recover.sh" >/dev/null
grep -qx 'up:web' "$work/actions.log"

echo 'health recovery tests: healthy, stale, unhealthy, and missing service paths passed'
