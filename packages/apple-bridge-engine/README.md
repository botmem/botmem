# @botmem/apple-bridge-engine

In-process **Rust** engine for the Botmem Apple Bridge. It is linked as a static
library into the Swift menu-bar app — the single process that holds macOS Full
Disk Access — so the FDA-granted process is the one that reads the local Apple
databases. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for _why_ (the TCC/FDA
constraint) and [`PROTOCOL.md`](./PROTOCOL.md) for the frozen tunnel protocol the
engine must speak (the server side does not change).

> **Status: Phase 4 complete** — the engine is feature-complete vs the node
> bridge. Implemented and tested: the C ABI, config, status writer, logging,
> tokio runtime, the X25519/HKDF/AES-256-GCM tunnel (verified against live prod),
> the bundled-SQLite FTS5 index (bm25, behavior-matched to the node engine), the
> Contacts / WhatsApp / iMessage readers (incl. the `attributedBody` typedstream
> decode), and WhatsApp PDF/DOCX/TXT attachment text extraction (realpath-confined).
> **Next: Phase 5** — a parity harness (old node vs new Rust on the same fixtures)
> before Phase 6 swaps out the bundled node engine. Run the live handshake check
> with `cargo run --example connect` (set `BRIDGE_TOKEN`/`BRIDGE_SERVER`).

## Layout

```
Cargo.toml                 staticlib + cdylib + rlib
include/botmem_engine.h    hand-maintained C ABI header (matches src/ffi.rs)
src/
  lib.rs                   module root + re-exports
  ffi.rs                   C ABI (start / stop / status_json / free_string)
  engine.rs                lifecycle: tokio runtime + background loop + shutdown
  config.rs                EngineConfig (JSON from the Swift host)
  status.rs                atomic ~/.botmem/bridge-status.json writer (schema 1)
  logging.rs               tracing init (BOTMEM_BRIDGE_LOG)
  tunnel/                  Phase 2 — crypto constants pinned; client TODO
  index/                   Phase 3 — FTS5 store TODO
  sources/                 Phase 4 — Contacts/WhatsApp/iMessage readers TODO
scripts/smoke/             Swift↔Rust link smoke test (run.sh)
```

## Build

```bash
# library + tests
cargo test --manifest-path packages/apple-bridge-engine/Cargo.toml

# release staticlib (what the Swift app links)
cargo build --release --manifest-path packages/apple-bridge-engine/Cargo.toml
# → target/release/libbotmem_engine.a
```

For the shipping arm64 app, build the matching target:

```bash
rustup target add aarch64-apple-darwin
cargo build --release --target aarch64-apple-darwin \
  --manifest-path packages/apple-bridge-engine/Cargo.toml
# → target/aarch64-apple-darwin/release/libbotmem_engine.a
```

## C ABI

```c
int32_t botmem_engine_start(const char *config_json);  // 0 = BOTMEM_OK
int32_t botmem_engine_stop(void);
char   *botmem_engine_status_json(void);               // caller frees
void    botmem_engine_free_string(char *s);
```

`config_json`:

```json
{
  "token": "apple_bt_…",
  "server": "wss://api.botmem.xyz/apple-tunnel",
  "sources": "contacts,imessages,whatsapp",
  "status_path": "…optional…",
  "data_dir": "…optional…"
}
```

Every entry point catches Rust panics so none cross the C boundary. Strings from
`status_json` are owned by the caller — release with `free_string`.

## Linking from Swift

The app is built with `swiftc` (no Xcode project). Import the C module via a
modulemap and link the staticlib:

```bash
swiftc App.swift \
  -I packages/apple-bridge-engine/include \
  -Xcc -fmodule-map-file=<modulemap pointing at botmem_engine.h> \
  -L packages/apple-bridge-engine/target/<triple>/release \
  -lbotmem_engine \
  -lresolv -framework CoreFoundation -framework Security
```

`-lresolv` + `CoreFoundation`/`Security` satisfy Rust std's transitive macOS
deps. Verify the integration any time with:

```bash
packages/apple-bridge-engine/scripts/smoke/run.sh
# → "OK: Swift↔Rust FFI link verified (start → status → file → stop)"
```

## Regenerate the header (optional)

The header is hand-maintained to stay readable. To regenerate with cbindgen:

```bash
cargo install cbindgen
cbindgen --lang c --output include/botmem_engine.h \
  packages/apple-bridge-engine
```

## Privacy

No user content (message text, names, phone numbers, chat ids) is ever written
to logs or the status file — only states, source names, counts, and durations.
