#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MACOS="$ROOT/macos"
MODE="${1:---current}"

target_for_arch() {
  case "$1" in
    arm64) echo "aarch64-apple-darwin" ;;
    x86_64) echo "x86_64-apple-darwin" ;;
    *) echo "unsupported architecture: $1" >&2; exit 2 ;;
  esac
}

build_arch() {
  local arch="$1"
  local target
  target="$(target_for_arch "$arch")"
  if ! rustup target list --installed | grep -qx "$target"; then
    echo "missing Rust target $target (install it with: rustup target add $target)" >&2
    exit 3
  fi
  MACOSX_DEPLOYMENT_TARGET=14.0 CARGO_TARGET_DIR="$MACOS/.build/rust/cargo-$arch" \
    cargo build --locked --release --target "$target" \
      --manifest-path "$MACOS/rust-ffi/Cargo.toml"
  mkdir -p "$MACOS/.build/rust/$arch"
  install -m 0644 \
    "$MACOS/.build/rust/cargo-$arch/$target/release/libbotmem_device_ffi.a" \
    "$MACOS/.build/rust/$arch/libbotmem_device_ffi.a"
}

case "$MODE" in
  --current)
    ARCH="$(uname -m)"
    build_arch "$ARCH"
    mkdir -p "$MACOS/.build/rust/current"
    install -m 0644 \
      "$MACOS/.build/rust/$ARCH/libbotmem_device_ffi.a" \
      "$MACOS/.build/rust/current/libbotmem_device_ffi.a"
    ;;
  --universal)
    build_arch arm64
    build_arch x86_64
    mkdir -p "$MACOS/.build/rust/universal" "$MACOS/.build/rust/current"
    xcrun lipo -create \
      "$MACOS/.build/rust/arm64/libbotmem_device_ffi.a" \
      "$MACOS/.build/rust/x86_64/libbotmem_device_ffi.a" \
      -output "$MACOS/.build/rust/universal/libbotmem_device_ffi.a"
    install -m 0644 \
      "$MACOS/.build/rust/universal/libbotmem_device_ffi.a" \
      "$MACOS/.build/rust/current/libbotmem_device_ffi.a"
    test "$(xcrun lipo -archs "$MACOS/.build/rust/current/libbotmem_device_ffi.a")" = "x86_64 arm64" || {
      echo "Rust static library is not universal" >&2
      exit 4
    }
    ;;
  *)
    echo "usage: $0 --current|--universal" >&2
    exit 2
    ;;
esac

NM_OUTPUT="$(nm -gU "$MACOS/.build/rust/current/libbotmem_device_ffi.a" 2>/dev/null || true)"
grep -q '_botmem_device_probe$' <<<"$NM_OUTPUT"
grep -q '_botmem_device_sync$' <<<"$NM_OUTPUT"
echo "Rust FFI ready: $MACOS/.build/rust/current/libbotmem_device_ffi.a"
