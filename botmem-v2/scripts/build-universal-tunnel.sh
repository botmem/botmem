#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARM_TARGET="aarch64-apple-darwin"
INTEL_TARGET="x86_64-apple-darwin"
OUTPUT_DIR="$ROOT/target/universal-apple-darwin/release"
OUTPUT="$OUTPUT_DIR/botmem-tunnel"

for target in "$ARM_TARGET" "$INTEL_TARGET"; do
  if ! rustup target list --installed | grep -qx "$target"; then
    rustup target add "$target"
  fi
  MACOSX_DEPLOYMENT_TARGET=14.0 cargo build \
    --locked \
    --release \
    --manifest-path "$ROOT/Cargo.toml" \
    --package botmem-tunnel \
    --target "$target"
done

mkdir -p "$OUTPUT_DIR"
xcrun lipo -create \
  "$ROOT/target/$ARM_TARGET/release/botmem-tunnel" \
  "$ROOT/target/$INTEL_TARGET/release/botmem-tunnel" \
  -output "$OUTPUT"
chmod 0755 "$OUTPUT"
xcrun lipo "$OUTPUT" -verify_arch arm64 x86_64

echo "$OUTPUT"
