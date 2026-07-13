#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MACOS="$ROOT/macos"
OUT="$MACOS/release"
APP="$OUT/Botmem.app"
DMG="$OUT/Botmem.dmg"
EXPECTED_TUNNEL="$ROOT/target/universal-apple-darwin/release/botmem-tunnel"
if [[ -n "${BOTMEM_TUNNEL_EXECUTABLE:-}" && "$BOTMEM_TUNNEL_EXECUTABLE" != "$EXPECTED_TUNNEL" ]]; then
  echo "external botmem-tunnel helpers are not accepted" >&2
  exit 2
fi
export BOTMEM_TUNNEL_EXECUTABLE="$EXPECTED_TUNNEL"

rm -rf "$OUT"
mkdir -p "$OUT"
if ! "$ROOT/scripts/macos/release-preflight.sh" > "$OUT/release-preflight.json"; then
  cat "$OUT/release-preflight.json" >&2
  echo "macOS release preflight failed; see $OUT/release-preflight.json" >&2
  exit 2
fi

"$ROOT/scripts/macos/test.sh"
"$ROOT/scripts/macos/build-rust.sh" --universal
swift build --package-path "$MACOS" -c release --arch arm64 --arch x86_64
BIN_DIR="$(swift build --package-path "$MACOS" -c release --arch arm64 --arch x86_64 --show-bin-path)"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Helpers"
install -m 0755 "$BIN_DIR/Botmem" "$APP/Contents/MacOS/Botmem"
install -m 0755 "$BIN_DIR/botmem-device" "$APP/Contents/Resources/bin/botmem-device"
install -m 0755 "$BOTMEM_TUNNEL_EXECUTABLE" "$APP/Contents/Helpers/botmem-tunnel"
install -m 0644 "$MACOS/Resources/Info.plist" "$APP/Contents/Info.plist"
SOURCE_COMMIT="${BOTMEM_SOURCE_COMMIT:-$(git -C "$ROOT/.." rev-parse HEAD)}"
"$ROOT/scripts/macos/install-legal-resources.sh" \
  "$APP" "$BOTMEM_VERSION" "$BOTMEM_BUILD_NUMBER" "$SOURCE_COMMIT"
cmp "$ROOT/../LICENSE" "$APP/Contents/Resources/LICENSE.txt"
grep -Fqx "https://github.com/botmem/botmem/tree/$SOURCE_COMMIT" \
  "$APP/Contents/Resources/SOURCE-NOTICE.txt"
plutil -replace CFBundleShortVersionString -string "$BOTMEM_VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$BOTMEM_BUILD_NUMBER" "$APP/Contents/Info.plist"

for binary in \
  "$APP/Contents/MacOS/Botmem" \
  "$APP/Contents/Resources/bin/botmem-device" \
  "$APP/Contents/Helpers/botmem-tunnel"; do
  ARCHS="$(xcrun lipo -archs "$binary")"
  [[ "$ARCHS" == "x86_64 arm64" || "$ARCHS" == "arm64 x86_64" ]] || {
    echo "not universal: $binary ($ARCHS)" >&2; exit 4;
  }
done
NM_OUTPUT="$(nm -gU "$APP/Contents/MacOS/Botmem" 2>/dev/null || true)"
grep -q '_botmem_device_probe$' <<<"$NM_OUTPUT" || {
  echo "Botmem executable is not statically linked to the Rust device core" >&2; exit 5;
}
CLI_NM_OUTPUT="$(nm -gU "$APP/Contents/Resources/bin/botmem-device" 2>/dev/null || true)"
if grep -q '_botmem_device_probe$' <<<"$CLI_NM_OUTPUT"; then
  echo "CLI must not link the protected-source Rust adapter" >&2; exit 5
fi
if otool -L "$APP/Contents/MacOS/Botmem" | grep -q 'botmem_device'; then
  echo "Rust device core must be statically linked, not shipped as a dylib" >&2; exit 5
fi

for helper in "$APP/Contents/Resources/bin/botmem-device" "$APP/Contents/Helpers/botmem-tunnel"; do
  codesign --force --timestamp --options runtime --sign "$DEVELOPER_ID_APPLICATION" "$helper"
done
codesign --force --timestamp --options runtime \
  --entitlements "$MACOS/Resources/Botmem.entitlements" \
  --sign "$DEVELOPER_ID_APPLICATION" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --verbose=4 "$APP" 2>&1 | grep -q 'flags=.*runtime' || {
  echo "hardened runtime flag is absent" >&2; exit 6;
}

ZIP="$OUT/Botmem-notarization.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
APP_NOTARY_JSON="$OUT/app-notary.json"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait \
  --output-format json > "$APP_NOTARY_JSON"
[[ "$(plutil -extract status raw -o - "$APP_NOTARY_JSON")" == "Accepted" ]] || {
  cat "$APP_NOTARY_JSON" >&2; exit 7;
}
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"

hdiutil create -quiet -fs HFS+ -volname "Botmem" -srcfolder "$APP" "$DMG"
codesign --force --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$DMG"
DMG_NOTARY_JSON="$OUT/dmg-notary.json"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait \
  --output-format json > "$DMG_NOTARY_JSON"
[[ "$(plutil -extract status raw -o - "$DMG_NOTARY_JSON")" == "Accepted" ]] || {
  cat "$DMG_NOTARY_JSON" >&2; exit 8;
}
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

rm -f "$ZIP"
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
DMG_SHA256="$(cut -d ' ' -f 1 "$DMG.sha256")"
APP_SHA256="$(shasum -a 256 "$APP/Contents/MacOS/Botmem" | cut -d ' ' -f 1)"
CLI_SHA256="$(shasum -a 256 "$APP/Contents/Resources/bin/botmem-device" | cut -d ' ' -f 1)"
TUNNEL_SHA256="$(shasum -a 256 "$APP/Contents/Helpers/botmem-tunnel" | cut -d ' ' -f 1)"
LICENSE_SHA256="$(shasum -a 256 "$APP/Contents/Resources/LICENSE.txt" | cut -d ' ' -f 1)"
SOURCE_NOTICE_SHA256="$(shasum -a 256 "$APP/Contents/Resources/SOURCE-NOTICE.txt" | cut -d ' ' -f 1)"
cat > "$OUT/Botmem.dmg.cdx.json" <<JSON
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "bom-ref": "pkg:generic/botmem-macos@$BOTMEM_VERSION?build=$BOTMEM_BUILD_NUMBER",
      "name": "Botmem for macOS",
      "version": "$BOTMEM_VERSION",
      "licenses": [{ "license": { "id": "AGPL-3.0-only" } }],
      "hashes": [{ "alg": "SHA-256", "content": "$DMG_SHA256" }]
    }
  },
  "components": [
    {
      "type": "application",
      "bom-ref": "pkg:generic/botmem-app@$BOTMEM_VERSION",
      "name": "Botmem.app",
      "version": "$BOTMEM_VERSION",
      "hashes": [{ "alg": "SHA-256", "content": "$APP_SHA256" }]
    },
    {
      "type": "application",
      "bom-ref": "pkg:generic/botmem-device@$BOTMEM_VERSION",
      "name": "botmem-device",
      "version": "$BOTMEM_VERSION",
      "hashes": [{ "alg": "SHA-256", "content": "$CLI_SHA256" }]
    },
    {
      "type": "application",
      "bom-ref": "pkg:cargo/botmem-tunnel@0.1.0",
      "name": "botmem-tunnel",
      "version": "0.1.0",
      "hashes": [{ "alg": "SHA-256", "content": "$TUNNEL_SHA256" }]
    },
    {
      "type": "file",
      "bom-ref": "botmem-macos-license@$BOTMEM_VERSION",
      "name": "Contents/Resources/LICENSE.txt",
      "version": "$BOTMEM_VERSION",
      "licenses": [{ "license": { "id": "AGPL-3.0-only" } }],
      "hashes": [{ "alg": "SHA-256", "content": "$LICENSE_SHA256" }]
    },
    {
      "type": "file",
      "bom-ref": "botmem-macos-source-notice@$BOTMEM_VERSION",
      "name": "Contents/Resources/SOURCE-NOTICE.txt",
      "version": "$BOTMEM_VERSION",
      "hashes": [{ "alg": "SHA-256", "content": "$SOURCE_NOTICE_SHA256" }]
    }
  ],
  "dependencies": [
    {
      "ref": "pkg:generic/botmem-macos@$BOTMEM_VERSION?build=$BOTMEM_BUILD_NUMBER",
      "dependsOn": [
        "pkg:generic/botmem-app@$BOTMEM_VERSION",
        "pkg:generic/botmem-device@$BOTMEM_VERSION",
        "pkg:cargo/botmem-tunnel@0.1.0",
        "botmem-macos-license@$BOTMEM_VERSION",
        "botmem-macos-source-notice@$BOTMEM_VERSION"
      ]
    }
  ]
}
JSON
cat > "$OUT/release-verification.json" <<JSON
{
  "schema": "botmem.macos.release-verification.v1",
  "ok": true,
  "version": "$BOTMEM_VERSION",
  "buildNumber": "$BOTMEM_BUILD_NUMBER",
  "checks": {
    "universalApp": true,
    "universalCLI": true,
    "universalTunnel": true,
    "rustStaticallyLinkedInApp": true,
    "rustAbsentFromCLI": true,
    "developerId": true,
    "hardenedRuntime": true,
    "appNotarization": "Accepted",
    "appStapled": true,
    "appGatekeeper": true,
    "dmgNotarization": "Accepted",
    "dmgStapled": true,
    "dmgGatekeeper": true,
    "licenseBundled": true,
    "sourceNoticeBundled": true,
    "enrollmentLaunchAtLoginDefaultTested": true,
    "coldLoginResumeContractTested": true
  },
  "dmgSha256": "$DMG_SHA256",
  "licenseSha256": "$LICENSE_SHA256",
  "sourceNoticeSha256": "$SOURCE_NOTICE_SHA256",
  "sourceCommit": "$SOURCE_COMMIT",
  "cycloneDxSbom": "Botmem.dmg.cdx.json"
}
JSON
echo "Verified release: $DMG"
cat "$OUT/release-verification.json"
