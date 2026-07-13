#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${BOTMEM_V2_DEVICE_TEST_DATABASE_URL:?BOTMEM_V2_DEVICE_TEST_DATABASE_URL is required}"
: "${BOTMEM_V2_DEVICE_TEST_REDIS_URL:?BOTMEM_V2_DEVICE_TEST_REDIS_URL is required}"

cargo build --locked --manifest-path "$ROOT/Cargo.toml" --package botmem-tunnel
cargo build --locked --manifest-path "$ROOT/Cargo.toml" \
  --package botmem-device-core --example seed_canary_index

export BOTMEM_V2_DEVICE_PROCESS_CANARY=1
export BOTMEM_TUNNEL_TEST_BINARY="$ROOT/target/debug/botmem-tunnel"
export BOTMEM_DEVICE_SEED_BINARY="$ROOT/target/debug/examples/seed_canary_index"
pnpm --dir "$ROOT" --filter @botmem-v2/api exec vitest run \
  src/devices/botmem-tunnel.process.integration.test.ts --reporter=verbose
