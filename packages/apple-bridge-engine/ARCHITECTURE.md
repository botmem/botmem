# Apple Bridge Engine — Architecture

Decision record for the Rust rewrite of the Botmem Apple Bridge engine.
Based on the Codex 5.5 plan (2026-06) and the macOS FDA constraint.

## The constraint that drives everything

macOS Full Disk Access (FDA / TCC) is keyed to a process's code-signing identity
(cdhash). To read `~/Library/Messages/chat.db`, the WhatsApp group container, and
the AddressBook DBs, **the reading process must itself hold FDA, continuously**
(this is a live system, not a one-time import).

Under **ad-hoc signing** (no Apple Developer ID / Team ID), a _separately spawned_
helper process does NOT inherit the parent app's FDA grant. That is exactly why
the previous design (Swift app shell → bundled `node` + `dist/cli.js` helper)
broke: the node child got blocked reading `chat.db` and looped on preflight.

**A separately-spawned helper of ANY language (Go, Rust, Node) hits the same
wall.** Spawning a Rust subprocess does not fix it. The fix requires the single
FDA-granted process to BE the reader.

## Chosen shape: Shape B — Swift app + in-process Rust engine

```
BotmemAppleBridge.app                (ONE process — holds FDA)
├── Swift/Cocoa shell
│     • menu-bar UI (LSUIElement / accessory)
│     • deep-link handling (botmem-apple-bridge://connect)
│     • LaunchAgent install/remove
│     • FDA guidance + "Open Full Disk Access" button
│     • Keychain (bridge token)
│     • app lifecycle
└── Rust engine  (static library `libbotmem_engine.a`, linked in-process)
      • iMessage / WhatsApp / Contacts readers   (read in THIS process → has FDA)
      • attachment text extraction (PDF/DOCX)
      • local FTS5 index
      • encrypted tunnel client (x25519 + HKDF + AES-256-GCM, JSON-RPC)
      • status writer (~/.botmem/bridge-status.json)
```

Why not Shape A (one all-Rust binary that is also the UI)? Native macOS
menu-bar UX, URL-scheme registration, LaunchAgent install, and notarized
packaging are all cleaner in Swift. Why not a separate Rust daemon? FDA
inheritance (above) — only acceptable under a persistent Developer ID identity.

## Language: Rust

`rusqlite` (bundled SQLite + FTS5), audited `x25519-dalek`/`hkdf`/`sha2`/`aes-gcm`,
`tokio` + `tokio-tungstenite`, clean `staticlib` C-ABI for the Swift link. Go was
rejected: weaker Cocoa story, awkward cgo/static packaging.

## C ABI (Swift ↔ Rust boundary)

Swift owns the process and app lifecycle; Rust owns the engine lifecycle. Minimal
C ABI (see `include/botmem_engine.h`):

- `botmem_engine_start(const char* config_json) -> int32_t` (0 = ok)
- `botmem_engine_stop() -> int32_t`
- `botmem_engine_status_json() -> char*` (caller frees via `botmem_engine_free_string`)
- `botmem_engine_free_string(char*)`

The status file (`~/.botmem/bridge-status.json`) remains the primary UI source of
truth; the `status_json` call is a convenience mirror. This keeps the Swift
integration thin and avoids callback-heavy FFI.

## Signing & FDA

- **Now: ad-hoc.** Apple Developer ID requires the paid Apple Developer Program
  ($99/yr), which we don't have. Under ad-hoc, the cdhash changes every build, so
  **the user must re-grant Full Disk Access after each update**. The UI must say
  this plainly.
- **Later: Developer ID** (recommended for public distribution). Stable identity →
  FDA survives updates, enables notarization. This is a CI cert/config change
  only — no architecture change.

## Phasing (migration off the Node engine)

- **Phase 0 — freeze protocol** → `PROTOCOL.md`. ✅
- **Phase 1 — Rust engine skeleton in-process**: crate + C ABI + lifecycle
  (start/stop/status) + tokio runtime + tracing logging + config parse + status
  JSON writer. Swift link wiring documented. ✅
- **Phase 2 — tunnel compatibility**: WS client + x25519/HKDF/AES-GCM handshake +
  encrypted JSON-RPC; validate against the live API with NO server changes.
  ✅ Verified against prod (`wss://api.botmem.xyz/apple-tunnel`) — handshake
  accepted, encrypted session established. `StubDispatcher` answers ping /
  bridge.status; search.query reports the index unavailable until Phase 3.
- **Phase 3 — local FTS5 index**: SQLite index, migrations, `search.query` shape.
  ✅ `rusqlite` (bundled FTS5) store ported from `index-store.ts` — same schema,
  `{text sender_name}` MATCH, bm25 ordering, SearchItem mapping. `IndexDispatcher`
  wires search.query/bridge.status; engine opens `~/.botmem/apple-bridge/
index.sqlite`. Verified by a wire roundtrip test (encrypt→dispatch→decrypt).
  Empty until Phase 4 populates it.
- **Phase 4 — source readers**: Contacts → WhatsApp → iMessage text →
  `attributedBody` typedstream → attachments → PDF/DOCX.
  - **4a ✅** Contacts (abcddb, all accounts), WhatsApp (ChatStorage text +
    captions + ContactsV2 name resolution), iMessage (chat.db incl.
    attributedBody decode), + the index build driver (read-only opens, batched
    inserts, status progress, graceful no-FDA degradation). All fixture-tested.
  - **4b ✅** WhatsApp PDF/DOCX/TXT/CSV/MD attachment text extraction
    (`pdf-extract`, `zip`+`quick-xml`), realpath-confined to the container
    (path-traversal rejected), size/char caps, best-effort. Incremental refresh
    (vs the current full rebuild on start) remains a later optimization.
- **Phase 5 — parity harness**: old Node vs new Rust on the same fixtures; golden
  queries.
- **Phase 6 — replace runtime**: remove bundled `node` + `dist/cli.js` + node
  supervisor/preflight; migrate config/status paths without breaking onboarding.
- **Phase 7 — release**: ad-hoc beta → (Developer ID when available).

## Ranked risks (de-risk first)

1. iMessage `attributedBody` typedstream decode (weak lib support) — spike first.
2. FTS parity with `better-sqlite3` FTS5 (tokenizer/ranking) — golden queries.
3. PDF extraction quality (text layer only; no OCR).
4. WhatsApp schema drift (introspect at startup; surface unsupported clearly).
5. TCC across ad-hoc updates (clear UI copy; recommend Developer ID).
6. Swift/Rust lifecycle + tokio runtime ownership across FFI.
