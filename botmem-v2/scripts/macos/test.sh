#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$ROOT/scripts/macos/legal-resources-test.sh"
"$ROOT/scripts/macos/build-rust.sh" --current
cargo test --locked --manifest-path "$ROOT/macos/rust-ffi/Cargo.toml"
swift test --package-path "$ROOT/macos"
