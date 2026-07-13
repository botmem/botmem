# Apple Bridge Tunnel Protocol — FROZEN SPEC (v1)

This document freezes the wire protocol between the Botmem Apple Bridge (the Mac
client) and the Botmem API (`/apple-tunnel` WebSocket gateway). The Rust engine
rewrite (`@botmem/apple-bridge-engine`) MUST match this byte-for-byte so the
**server side requires no changes**.

Authoritative sources this was distilled from (do not diverge from these without
also changing the server):

- Client crypto: `packages/apple-bridge/src/crypto.ts`
- Client tunnel: `packages/apple-bridge/src/tunnel.ts`
- Client RPC surface: `packages/apple-bridge/src/rpc-handler.ts`
- Result/status shapes: `packages/apple-bridge/src/local-index/types.ts`, `src/status-writer.ts`
- Server gateway: `apps/api/src/apple-tunnel/apple-tunnel.gateway.ts`
- Server crypto + RPC relay: `apps/api/src/apple-tunnel/apple-tunnel.service.ts`

---

## 1. Transport

- WebSocket. Production URL: `wss://api.botmem.xyz/apple-tunnel`.
  - NOTE: the tunnel host is always `api.botmem.xyz`. The web app rewrites
    `app.botmem.xyz`/`botmem.xyz` → `api.botmem.xyz` (see `apps/web/src/lib/urls.ts`).
- Client connects with HTTP header `User-Agent: botmem-apple-bridge/<version>`.
- The client is the WebSocket **client**; the server **accepts**.
- After auth, the **server is the RPC caller** and the **bridge is the RPC
  responder**. The bridge never initiates JSON-RPC requests; it only answers.

### Close codes (observed)

- `1000` — normal client shutdown ("Bridge shutting down").
- `4400` — bad auth message / missing server public key.
- `4401` — auth failed / invalid token / auth timeout (server side, 10s).

### Keepalive

- WebSocket-level **ping/pong frames** (not JSON messages).
- Client pings every `30_000 ms`; if no pong within `10_000 ms`, client
  terminates and reconnects.
- Server also pings every `30_000 ms`; server treats a session as stale after
  `90_000 ms` without traffic (`HEARTBEAT_STALE_MS`) and starts a 60s grace
  period on disconnect (`GRACE_PERIOD_MS`).

### Reconnect (client)

- Exponential backoff: `min(1000 * 2^attempt, 30_000) ms`.
- Auth failure (`ok:false`) is **permanent** — do NOT reconnect.

---

## 2. Handshake (JSON text frames)

Exactly two JSON text frames, then the channel switches to encrypted binary.

### 2.1 Client → Server: `auth`

```json
{
  "event": "auth",
  "data": {
    "token": "apple_bt_<64 hex chars>",
    "publicKey": "<base64 of raw 32-byte X25519 public key>",
    "sources": "contacts,imessages,whatsapp"
  }
}
```

- `token`: bridge token, prefix `apple_bt_` (also legacy `imsg_bt_` accepted by
  some flows). Looked up server-side against encrypted account `authContext`.
- `publicKey`: **raw 32-byte** X25519 public key, base64-encoded. (Not DER — the
  raw key only; see §4 for the DER header handling.)
- `sources`: optional comma-separated source list. Parsed server-side
  (`contacts`, `imessages`|`messages`, `whatsapp`). Defaults to
  `contacts,imessages` when absent. `whatsapp` is auto-detected and excluded
  from the server's selection-mismatch guard.

Server must receive this within `10_000 ms` or it closes with `4401`.

### 2.2 Server → Client: `auth` response

On success:

```json
{
  "event": "auth",
  "data": {
    "ok": true,
    "publicKey": "<base64 raw 32-byte server X25519 pub>",
    "sessionId": "<uuid>"
  }
}
```

On failure:

```json
{ "event": "auth", "data": { "ok": false, "reason": "Invalid token" } }
```

- Client derives the session key from its private key + the server's
  `publicKey`. `sessionId` is informational (client does not use it).
- `ok:false` → client emits a fatal error and stops (no reconnect).

---

## 3. Encrypted channel (binary frames)

After a successful handshake, **every** frame in both directions is a binary
WebSocket frame containing one AES-256-GCM payload (see §4). The decrypted
plaintext is a UTF-8 JSON-RPC 2.0 message.

- Server → Bridge: JSON-RPC **request**.
- Bridge → Server: JSON-RPC **response** (matched by `id`).

### Request shape (server → bridge)

```json
{ "jsonrpc": "2.0", "id": 1, "method": "search.query", "params": { ... } }
```

- `id` is a monotonic integer per session (server `nextRpcId`, starts at 1).
- `params` is omitted when empty.
- Server RPC timeout: `30_000 ms` (`RPC_TIMEOUT_MS`); live-search path uses
  `bridgeSearchTimeoutMs` (default `8000 ms`).

### Response shape (bridge → server)

Success:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { ... } }
```

Error:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found: x" } }
```

- A response with no/`null` `id` is dropped by the server. Always echo the
  request `id`.
- Error codes in use: `-32601` (method not found / index unavailable),
  `-32602` (invalid params), `-32000` (handler threw).

---

## 4. Crypto (MUST match exactly)

Key agreement and framing — identical constants on both ends.

1. **Curve**: X25519 (RFC 7748). Each side generates an ephemeral keypair per
   connection.
2. **Public key on the wire**: raw 32 bytes, base64. When importing a raw key,
   both ends prepend the X25519 SPKI DER header
   `302a300506032b656e032100` (hex) to reconstruct an SPKI DER key. The Node
   `exportPublicKey` strips the first 12 DER bytes to emit the raw 32 bytes.
3. **Shared secret**: ECDH (`diffieHellman`) → 32 bytes.
4. **KDF**: HKDF-SHA256 over the shared secret:
   - salt = UTF-8 bytes of `"botmem-apple-tunnel-v1"`
   - info = UTF-8 bytes of `"aes-256-gcm-session-key"`
   - length = 32 bytes → AES-256 key.
5. **AEAD**: AES-256-GCM.
   - IV: 12 random bytes per frame.
   - Tag: 16 bytes.
   - **Frame layout**: `[IV (12 bytes)] [ciphertext] [tag (16 bytes)]`, sent as
     a single binary WebSocket message.
   - No additional authenticated data (AAD).
   - Plaintext is the UTF-8 JSON string.

Minimum valid frame length = 12 + 16 = 28 bytes; shorter is rejected.

---

## 5. RPC methods the bridge MUST implement

(Method surface from `rpc-handler.ts`. Only `search.query` and `bridge.status`
are exercised by the current server live-search path, but the full set must
remain for compatibility / the connector transport.)

### `search.query`

Params: `{ query: string, filters?: SearchFilters, limit?: number }`

- `query` required, non-empty. Else `-32602`.
- `limit`: clamped to `[1, 200]`, default `25`.
- `filters` (`SearchFilters`):
  ```ts
  {
    source?: string;            // internal: imessage|whatsapp|contacts
    sourceType?: string;        // wire: message|contact
    connectorType?: string;     // wire: apple|whatsapp|contacts → mapped to source
    connectorTypes?: string[];  // multi (web sends these)
    sourceTypes?: string[];     // multi: message|contact
  }
  ```
  Result: `{ items: SearchItem[] }` where each `SearchItem`:

```ts
{
  id: string;                 // `${source}:${sourceId}`
  connectorType: 'apple' | 'whatsapp' | 'contacts'; // imessage→apple
  sourceType: 'message' | 'contact';
  text: string;
  eventTime: string | null;   // ISO 8601, null for contacts
  people: Array<{ name: string; durableId: string }>;
  threadTitle: string;
  isFromMe: boolean;
  media: unknown[];
  score: number;              // higher = better (negated bm25 rank)
}
```

If no local index available → `-32601` "Local search index not available".

### `bridge.status`

Params: none.
Result: `{ sources: Array<{ source: 'imessage'|'whatsapp'|'contacts', count: number, lastIndexedAt: number | null }> }`

- `lastIndexedAt` is **epoch milliseconds** (number) or null. (Server normalizes
  number→ISO; numeric strings also accepted.)
- If no index available → `{ sources: [] }`.

### `ping`

Result: `{ pong: true, ts: <epoch ms> }`.

### Legacy methods (keep for connector transport compatibility)

- `chats.list` → `{ chats }`. Param `limit?`.
- `messages.history` → `{ messages }`. Param `chat_id` (number, required, else
  `-32602`), `limit?`, `start?`, `end?`.
- `contacts.list` → `{ contacts }`.

Unknown method → `-32601` "Method not found: <method>".

### Server `__status` relay sentinel

The server's Redis relay uses an internal method name `__status` that it answers
itself (returns `true`) — it is **never sent to the bridge**. The bridge does not
implement it.

---

## 6. Status file (Swift UI ↔ engine contract)

Atomic JSON at `~/.botmem/bridge-status.json` (override `BRIDGE_STATUS_PATH`).
Written tmp-then-rename, mode `0600`. The Swift app polls this file. Schema
(`STATUS_SCHEMA = 1`):

```ts
{
  schema: 1;
  state: 'starting' | 'connecting' | 'indexing' | 'live' | 'error' | 'offline';
  label: string; // human-readable
  server: string; // wss url in use
  connected: boolean; // tunnel connected
  sources: Array<{ source: 'whatsapp' | 'imessage' | 'contacts'; count: number }>;
  indexing: {
    active: boolean;
    source: string | null;
    done: number;
    total: number | null;
  }
  activity: Array<{ ts: number; text: string }>; // newest LAST, max 12
  lastError: string | null;
  updatedAt: number; // epoch ms
}
```

PRIVACY (hard rule, from CLAUDE.md): the status file and activity log contain
ONLY states, source names, counts, and durations — never message text, contact
names, phone numbers, or chat ids.

---

## 7. Deep link & config

- URL scheme: `botmem-apple-bridge://connect` carries onboarding token + server.
- The web "connect" command currently is:
  `npx @botmem/apple-bridge@latest --token='<apple_bt_…>' --server='wss://api.botmem.xyz/apple-tunnel'`
  (no `--account-id`). The Rust engine accepts the same `token`/`server` config.
- Token storage: prefer macOS Keychain (Swift owns it); non-secret config JSON
  under `~/.botmem/apple-bridge/config.json`.

---

## 8. Invariants the rewrite must preserve

1. Server side is **unchanged**. All of §2–§5 are fixed.
2. Zero server-side storage of user data — only `search.query` **results** cross
   the tunnel; never the corpus or the index.
3. The FDA-granted process is the same process that reads the local DBs (see
   `ARCHITECTURE.md`). No separate reader subprocess under ad-hoc signing.
4. No user content in any log or status field (§6).
