#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$ROOT/.tmp/cli-package"
OUTPUT="$ROOT/artifacts/cli"
SECOND_PACK="$(mktemp -d)"
SMOKE="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$STAGING" "$SECOND_PACK" "$SMOKE"
}
trap cleanup EXIT
export LC_ALL=C
umask 077
VERSION="${BOTMEM_VERSION:-$(node -p "require('$ROOT/packages/cli/package.json').version")}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || {
  echo 'BOTMEM_VERSION must be a semantic version' >&2
  exit 2
}

rm -rf "$STAGING" "$OUTPUT"
mkdir -p "$STAGING/bin" "$OUTPUT"

pnpm --dir "$ROOT" --filter @botmem-v2/contracts build
pnpm --dir "$ROOT" --filter @botmem-v2/sdk build
pnpm --dir "$ROOT" --filter @botmem-v2/cli exec esbuild \
  "$ROOT/packages/cli/src/bin.ts" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --metafile="$STAGING/esbuild-meta.json" \
  --outfile="$STAGING/bin/botmem.mjs"
chmod 0755 "$STAGING/bin/botmem.mjs"
node - "$ROOT/packages/cli/standalone/package.json" "$STAGING/package.json" "$VERSION" <<'NODE'
const [source, destination, version] = process.argv.slice(2);
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
manifest.version = version;
fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
node - "$ROOT/packages/cli/standalone/README.md" "$STAGING/README.md" "$VERSION" <<'NODE'
const [source, destination, version] = process.argv.slice(2);
const fs = require('node:fs');
fs.writeFileSync(destination, fs.readFileSync(source, 'utf8').replaceAll('0.1.0', version));
NODE
cp "$ROOT/../LICENSE" "$STAGING/LICENSE"

npm pack "$STAGING" --pack-destination "$OUTPUT" >/dev/null
npm pack "$STAGING" --pack-destination "$SECOND_PACK" >/dev/null
ARTIFACT="$OUTPUT/botmem-v2-cli-$VERSION.tgz"
SECOND_ARTIFACT="$SECOND_PACK/botmem-v2-cli-$VERSION.tgz"
cmp -s "$ARTIFACT" "$SECOND_ARTIFACT" || {
  echo 'standalone CLI package is not reproducible' >&2
  exit 1
}

(
  cd "$OUTPUT"
  shasum -a 256 "$(basename "$ARTIFACT")" > "$(basename "$ARTIFACT").sha256"
)
node "$ROOT/scripts/create-cli-sbom.mjs" \
  "$ARTIFACT" \
  "$STAGING/esbuild-meta.json" \
  "$ARTIFACT.cdx.json" \
  "$VERSION"

npm install --ignore-scripts --no-audit --no-fund --prefix "$SMOKE" "$ARTIFACT" >/dev/null
test "$("$SMOKE/node_modules/.bin/botmem" --version)" = "$VERSION"
test "$("$SMOKE/node_modules/.bin/botmem-v2" --version)" = "$VERSION"
test "$(tar -xOf "$ARTIFACT" package/package.json | node -e "let value=''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => { if (JSON.parse(value).license !== 'AGPL-3.0-only') process.exit(1); })")" = ''
tar -tf "$ARTIFACT" > "$SMOKE/archive-files.txt"
grep -qx 'package/LICENSE' "$SMOKE/archive-files.txt"
"$SMOKE/node_modules/.bin/botmem" --help > "$SMOKE/help.txt"
grep -q 'BOTMEM_ACCESS_TOKEN' "$SMOKE/help.txt"
PORT_FILE="$SMOKE/api-url"
node "$ROOT/scripts/cli-package-smoke-server.mjs" "$PORT_FILE" &
SERVER_PID="$!"
for _ in {1..50}; do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.1
done
test -s "$PORT_FILE"
API_URL="$(cat "$PORT_FILE")"
WORKSPACE_ID='8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf'
ACCESS_TOKEN="bmp_v2.$(printf 'A%.0s' {1..43})"
for command in search connections devices; do
  case "$command" in
    search) arguments=(search --workspace "$WORKSPACE_ID" --query launch --json) ;;
    connections) arguments=(connections list --workspace "$WORKSPACE_ID" --json) ;;
    devices) arguments=(devices status --workspace "$WORKSPACE_ID" --json) ;;
  esac
  BOTMEM_API_URL="$API_URL" BOTMEM_ACCESS_TOKEN="$ACCESS_TOKEN" \
    "$SMOKE/node_modules/.bin/botmem" "${arguments[@]}" > "$SMOKE/$command.json"
  node -e "const value=JSON.parse(require('node:fs').readFileSync(process.argv[1])); if(value.version!==2) process.exit(1)" \
    "$SMOKE/$command.json"
done

echo "CLI artifact: $ARTIFACT"
echo "Checksum: $ARTIFACT.sha256"
echo "SBOM: $ARTIFACT.cdx.json"
