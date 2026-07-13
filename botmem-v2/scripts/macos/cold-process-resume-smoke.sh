#!/bin/bash
set -euo pipefail

APP="${BOTMEM_INSTALLED_APP_PATH:-/Applications/Botmem.app}"
: "${BOTMEM_SETUP_PAYLOAD_FILE:?path to a mode-0600 one-time setup payload is required}"
DEVICE_NAME="${BOTMEM_DEVICE_NAME:-Botmem cold-resume smoke}"
CLI="$APP/Contents/Resources/bin/botmem-device"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

[[ -d "$APP" && -x "$CLI" ]] || { echo 'installed signed Botmem app is required' >&2; exit 2; }
[[ -f "$BOTMEM_SETUP_PAYLOAD_FILE" && ! -L "$BOTMEM_SETUP_PAYLOAD_FILE" ]] \
  || { echo 'setup payload must be a regular non-symlink file' >&2; exit 2; }
[[ "$(stat -f '%Lp' "$BOTMEM_SETUP_PAYLOAD_FILE")" == 600 ]] \
  || { echo 'setup payload file must have mode 0600' >&2; exit 2; }

codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=4 "$APP"

wait_for_status() {
  local output="$1"
  for _ in {1..100}; do
    if "$CLI" status > "$output" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}

open -na "$APP"
wait_for_status "$WORK/status-before.json"
"$CLI" enroll "$DEVICE_NAME" < "$BOTMEM_SETUP_PAYLOAD_FILE" > "$WORK/enrolled.json"
[[ "$(plutil -extract ok raw -o - "$WORK/enrolled.json")" == true ]]
[[ "$(plutil -extract snapshot.enrolled raw -o - "$WORK/enrolled.json")" == true ]]
LOGIN_STATE="$(plutil -extract snapshot.loginItem raw -o - "$WORK/enrolled.json")"
[[ "$LOGIN_STATE" == enabled ]] || {
  echo "macOS login-item approval is required (state=$LOGIN_STATE)" >&2
  exit 3
}
[[ "$(plutil -extract snapshot.service raw -o - "$WORK/enrolled.json")" == running ]]

"$CLI" service quit > "$WORK/quit.json"
for _ in {1..100}; do
  "$CLI" status >/dev/null 2>&1 || break
  sleep 0.1
done
if "$CLI" status >/dev/null 2>&1; then
  echo 'Botmem app did not quit before cold resume' >&2
  exit 4
fi

open -na "$APP"
wait_for_status "$WORK/resumed.json"
[[ "$(plutil -extract snapshot.enrolled raw -o - "$WORK/resumed.json")" == true ]]
[[ "$(plutil -extract snapshot.loginItem raw -o - "$WORK/resumed.json")" == enabled ]]
[[ "$(plutil -extract snapshot.service raw -o - "$WORK/resumed.json")" == running ]]

cat <<JSON
{"schema":"botmem.macos.cold-process-resume.v1","ok":true,"signedApp":true,"loginItem":"enabled","enrollmentReused":true,"service":"running"}
JSON
