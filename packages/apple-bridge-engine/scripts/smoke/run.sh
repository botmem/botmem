#!/usr/bin/env bash
# Build the release staticlib and link a tiny Swift binary against it to prove
# the in-process C-ABI integration the real Swift app will use.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$CRATE_DIR/scripts/smoke"
TARGET="${CARGO_BUILD_TARGET:-}"

source "$HOME/.cargo/env" 2>/dev/null || true

echo "==> building release staticlib"
cargo build --release --manifest-path "$CRATE_DIR/Cargo.toml"

LIB_DIR="$CRATE_DIR/target/release"
[ -n "$TARGET" ] && LIB_DIR="$CRATE_DIR/target/$TARGET/release"

OUT="$SMOKE_DIR/smoke-bin"
echo "==> linking swift smoke binary"
# -lbotmem_engine pulls in the staticlib; Rust std on macOS needs libresolv +
# the Security/CoreFoundation frameworks for some transitive deps.
swiftc "$SMOKE_DIR/main.swift" \
  -o "$OUT" \
  -I "$CRATE_DIR/include" \
  -Xcc -fmodule-map-file="$SMOKE_DIR/module.modulemap" \
  -L "$LIB_DIR" \
  -lbotmem_engine \
  -lresolv \
  -framework CoreFoundation \
  -framework Security

echo "==> running"
"$OUT"
rm -f "$OUT"
