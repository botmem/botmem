#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOADER="$ROOT/deploy/docker/run-with-secret-files.sh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

printf '%s\n' 'correct horse battery staple' > "$TEMP/secret"
RESULT="$(BOTMEM_TEST_SECRET_FILE="$TEMP/secret" sh "$LOADER" sh -c 'printf "%s" "$BOTMEM_TEST_SECRET"')"
[[ "$RESULT" == 'correct horse battery staple' ]]

if BOTMEM_TEST_SECRET=inline BOTMEM_TEST_SECRET_FILE="$TEMP/secret" \
  sh "$LOADER" true 2>"$TEMP/error"; then
  echo 'loader accepted an inline secret and a secret file together' >&2
  exit 1
fi
grep -q 'both BOTMEM_TEST_SECRET and BOTMEM_TEST_SECRET_FILE are set' "$TEMP/error"
if grep -q 'correct horse' "$TEMP/error"; then
  echo 'secret value leaked to stderr' >&2
  exit 1
fi

if BOTMEM_TEST_SECRET_FILE="$TEMP/missing" sh "$LOADER" true 2>"$TEMP/missing-error"; then
  echo 'loader accepted a missing secret file' >&2
  exit 1
fi
grep -q 'not a readable regular file' "$TEMP/missing-error"

dd if=/dev/zero of="$TEMP/large" bs=65537 count=1 status=none
if BOTMEM_TEST_SECRET_FILE="$TEMP/large" sh "$LOADER" true 2>"$TEMP/large-error"; then
  echo 'loader accepted an oversized secret file' >&2
  exit 1
fi
grep -q 'invalid size' "$TEMP/large-error"

echo 'secret file loader tests passed'
