# Architecture

## Deployment shape

V2 starts as a modular monolith with separately runnable gateway and worker
processes. PostgreSQL is the source of truth, Redis is ephemeral coordination,
and object storage holds remote attachments. The signed Mac app is a separate
trusted product boundary.

```text
Web / CLI / MCP
       |
       v
Gateway application ports
  |          |                 |
  v          v                 v
Hosted    Device relay     Identity/billing
search    (Redis presence)
  |          |
Postgres     +--> outbound TLS + signed device auth --> signed Mac apps

Remote providers --> connector adapters --> remote_event + outbox
                                             |
                                             v
                                      idempotent worker
                                             |
                                             v
                                  document + search_document

Stripe --> raw-body HMAC API intake --> reduced durable webhook queue
                                             |
                                             v
                      commerce reconciler (canonical GETs + cancellation)
                                  |                         |
                         subscription state     isolated identity provisioner
```

## Bounded contexts

### Identity and commerce

Owns users, sessions, recovery, subscriptions, scoped personal access tokens,
export, and deletion. Launch CLI and MCP clients use revocable, hashed PATs:
`botmem:search` is required, while connection and device status are separate
read-only scopes. Botmem does not advertise an OAuth authorization server it
does not operate. Product entitlements are enforced here, never inferred by a
client when billing is unavailable.

The API can create hosted Checkout/Portal sessions with a restricted key and
verify webhooks, but cannot provision identities or retrieve subscriptions. A
separate reconciler has a narrowly restricted Stripe key that can read canonical
Checkout/subscription state and cancel subscriptions, a dedicated commerce
login, and a second identity-admin login. Workspace deletion stays blocked until
remote billing is confirmed canceled (or no subscription exists). The success
redirect polls committed local state only; it is never evidence of payment and
can never provision a workspace.

### Connections

Owns authenticated connector accounts and sync cursors. Provider SDK models are
translated through anti-corruption adapters. OAuth state is single-use,
fail-closed, and atomically consumed. Provider client credentials are deployment
configuration, never user-editable records.

### Ingestion

Commits a remote event and outbox entry in one database transaction. Workers
lease outbox records and produce an idempotent document/search projection.
Failures remain visible repairable debt and never become false-success syncs.

### Search

Owns the public query contract and federation policy. Hosted PostgreSQL search
uses one versioned multilingual embedding profile with a matching HNSW index,
plus language-neutral lexical and trigram lanes. Device results arrive already
ranked. Reciprocal-rank fusion combines ranks without comparing raw scores.
The launch API deliberately omits federated pagination: local candidates are
never buffered in hosted cursor state. Provider sync cursors remain private to
connector ingestion and do not contain search content.

### Devices

Owns per-device registration, credential hashes, revocation, presence, and RPC
routing. Redis maps user/device/session to the gateway process that owns the
outbound WebSocket. Search fans out across eligible devices with bounded
deadlines and works when the HTTP request lands on another replica.

## Runtime security

- Database migrations run as a schema owner; API and worker roles are
  `NOSUPERUSER NOBYPASSRLS`.
- User-scoped transactions set tenant context locally. Narrow service operations
  use explicit service policies rather than a universal bypass role.
- Connector and device secrets use envelope encryption with rotation metadata.
  Device lookup uses an indexed credential hash, never decrypt-and-scan.
- Browser sessions use opaque `Secure`, `HttpOnly`, `SameSite` cookies. Browser
  JavaScript never receives bearer tokens; CLI and MCP credentials are separate,
  scoped, hashed server-side, revocable credentials.
- OwnTracks requires HTTPS and resolved public addresses by default; redirect
  targets are revalidated and connect/body deadlines are mandatory.
- The relay accepts outbound device connections only. Pairing uses a short-lived,
  single-use code. The device retains only its Ed25519 private identity in
  device-only Keychain storage; relay sessions are short-lived and issued only
  after a signed challenge over verified TLS.
- Logs and traces exclude tokens, queries, message bodies, participant values,
  attachment contents, and device RPC payloads.

## Mac product boundary

One signed `Botmem.app` owns protected local behavior, with one narrowly scoped
signed outbound helper:

- Swift: onboarding, Keychain, source consent, TCC status/actions, login-item and
  signed manual-release lifecycle.
- Statically linked Rust: protected source adapters, local database, incremental
  indexing, and active-generation search.
- Bundled Rust helper: verified outbound `wss`, signed-challenge/session protocol,
  and query-only access to the active local index. It receives no private key or
  long-lived credential and cannot open protected source databases.
- CLI: a controller that talks to the signed app; it never reads protected
  databases itself.

The local index uses per-source staged generations. A new scan is inactive until
it completes, then activation is atomic and the previous good generation is
retired. Incremental high-water cursors run between reconciliation scans.
Permission or schema failure cannot erase a valid generation. A cross-process
lock enforces one mutable engine owner; the tunnel is a concurrent read-only
SQLite/WAL consumer and cannot run schema or generation operations.

Source readiness is explicit:

`disabled | not_installed | permission_required | schema_unsupported | indexing | ready | error`

## Post-launch protocol work

Standards-based MCP OAuth may be added after launch with a real authorization
server, discovery metadata, consent, token audience validation, and revocation.
It is not a launch review gate and the current service intentionally publishes
no OAuth metadata; launch authentication is the scoped PAT contract above.

## Migration stance

V2 has a new schema and journal. A separate, repeatable migrator may copy users,
owned connector accounts, decryptable remote credentials, and raw remote events.
It rebuilds documents and search projections.

Legacy jobs, queue state, search rows, name-only people, graph links, bridge
credentials, server WhatsApp sessions, and local Node state are never migrated.
