#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?app bundle path is required}"
VERSION="${2:?version is required}"
BUILD_NUMBER="${3:?build number is required}"
SOURCE_COMMIT="${4:?source commit is required}"

[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "source commit must be a lowercase 40-character Git object id" >&2
  exit 2
}
[[ -f "$ROOT/../LICENSE" ]] || {
  echo "repository LICENSE is missing" >&2
  exit 2
}

mkdir -p "$APP/Contents/Resources"
install -m 0644 "$ROOT/../LICENSE" "$APP/Contents/Resources/LICENSE.txt"
cat > "$APP/Contents/Resources/SOURCE-NOTICE.txt" <<NOTICE
Botmem for macOS $VERSION (build $BUILD_NUMBER)

This application is licensed under GNU AGPL v3.0 only. The complete license is
included beside this notice as LICENSE.txt.

Corresponding source for this build:
https://github.com/botmem/botmem/tree/$SOURCE_COMMIT
NOTICE
