#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/botmem-legal-resources.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT INT TERM
COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
APP="$TEMP/Botmem.app"

"$ROOT/scripts/macos/install-legal-resources.sh" "$APP" "2.4.1" "20401" "$COMMIT"
cmp "$ROOT/../LICENSE" "$APP/Contents/Resources/LICENSE.txt"
grep -Fqx "https://github.com/botmem/botmem/tree/$COMMIT" \
  "$APP/Contents/Resources/SOURCE-NOTICE.txt"
grep -Fq 'GNU AGPL v3.0 only' "$APP/Contents/Resources/SOURCE-NOTICE.txt"
