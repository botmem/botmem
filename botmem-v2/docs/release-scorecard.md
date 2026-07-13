# Release scorecard

## Source and approval policy

The release workflow fetches full Git history, rejects any source commit that is
not an ancestor of `origin/main`, and requires a successful **Botmem v2 CI**
`push` run for that exact commit before packaging. Tagged releases attach a
machine-readable provenance record containing the commit and CI run URL.

GitHub repository policy remains an external control: protect the
`botmem-v2-v*` namespace with a ruleset that limits tag creation/deletion, keep
`main` protected with required v2 CI, and require reviewer approval on the
`botmem-v2-macos-release` environment. `gh release create --verify-tag` checks
that a tag exists; Botmem does not describe that as cryptographic tag signing.

This file is the live readiness record for the clean v2 rewrite. A component is
marked complete only when its implementation and deterministic verification are
both present. The product is not ready for human review while any automated gate
is open.

## Implemented and verified

- Minimal five-source product, placement, privacy, and acceptance contracts.
- Runtime-validated canonical search, source-status, workspace, and device
  protocol contracts shared by API, Web, CLI, MCP, and Rust.
- Tenant-isolated connector ingestion schema with forced RLS, immutable
  revisions, atomic cursor/outbox commits, and least-privilege runtime roles.
- Deterministic federated search with concurrent hosted/device lanes,
  reciprocal-rank fusion, durable deduplication, bounded deadlines, and honest
  partial/offline/permission/indexing/failure coverage.
- Bounded single-result-set launch search with no hosted cursor state capable of
  retaining local result content.
- Gmail OAuth/PKCE, immutable OpenID subject binding, bounded provider transport,
  full/history sync, token rotation, tombstones, and atomic page commits.
- Outlook OAuth/PKCE, immutable Graph identity, bounded transport, per-folder
  delta sync, immutable IDs, token rotation, tombstones, and atomic page commits.
- OwnTracks Basic-auth connector with pinned public DNS resolution, redirect
  validation, DNS-rebinding and special-address defenses, bounded reconciliation,
  and atomic page commits.
- Rust read-only iMessage and WhatsApp schema adapters, stable IDs/revisions,
  incremental and reconciliation scans, staged generations, last-good recovery,
  and explicit source readiness.
- Rust active-generation SQLite FTS5 with Arabic normalization, indexed
  vocabulary typo tolerance, deterministic ranking and filters, and
  cancellation. The enforced 100,000-item real-helper/TLS process gate measured
  local p95 323.0 ms, federated p95 327.6 ms, and federated p99 360.8 ms against
  limits of 750 ms, 1.5 s, and 3 s respectively.
- PostgreSQL hosted projection/search, immutable active heads, multilingual
  lexical/trigram/semantic lanes, evidence-backed readiness, repair scan, and
  fresh PostgreSQL 17/pgvector invariants. A clean PostgreSQL 17 run with all
  V1--V15 migrations and 100,000 hosted documents measured p50 113.025 ms,
  p95 239.982 ms, and p99 251.302 ms in the mixed
  semantic/lexical/Arabic/typo workload. Embedding-outage fallback measured
  p50 23.102 ms, p95 118.414 ms, and p99 124.489 ms. Both paths remain below
  the 500 ms release gate.
- Production PostgreSQL connector-ingestion unit of work exercised through the
  least-privilege worker role: sync lease, revision, head, content-free outbox,
  cursor, and aggregate state commit atomically.
- Signed-device domain and protocol seams for single-use pairing/challenges,
  Ed25519 authentication, rotation/revocation/rate limits, bounded routing,
  replica-neutral presence, and hosted/device source-status aggregation.
- Concrete PostgreSQL/Redis/WebSocket device adapters and real Rust-process
  canary covering public one-time pairing, strict TLS, signed authentication,
  read-only local search, cancellation, reconnect, graceful stop, revocation,
  and no local-corpus persistence in PostgreSQL, Redis, or logs.
- macOS SwiftUI/CLI shell with shared control service, device-only Keychain
  identity, Full Disk Access preflight, login item, private peer-checked IPC,
  reconnecting tunnel lifecycle, static Rust app linkage, Universal builds, and
  fail-closed release verification. The final signed bundle includes the exact
  AGPL-3.0-only license and a commit-pinned corresponding-source notice; both
  are hashed in release evidence and the CycloneDX SBOM. Signing/notarization
  remain human gates.
- Production Web search slice with real API contracts, no mock success, source
  truth rail, all-result rendering, partial states, accessibility, responsive
  design, reduced motion, and HttpOnly ambient-session boundary.
- Production Web connections slice for Gmail/Outlook OAuth launch, OwnTracks
  Basic setup, hosted sync/disconnect status, and paired Mac/source truth. The
  deterministic render fixture, 39 tests, production build/typecheck, and React
  Doctor 100/100 pass; the real-Chrome gate remains explicitly open below.
- Canonical CLI search binary exercised as a separate process against a real
  ephemeral HTTP server.
- MCP server exercised through the official stable SDK and authenticated
  Streamable HTTP, with protected-resource metadata and Origin/Host validation.
- Contract-validated connection/device status clients and read-only CLI/MCP
  surfaces (`connections list`, `devices status`, `connections.list`, and
  `devices.status`).
- Hosted subscription Checkout, exact raw-body Stripe signatures, fast durable
  webhook intake, unordered canonical reconciliation, renewal/failure events,
  isolated idempotent identity provisioning, entitlement enforcement, Billing
  Portal, and pricing/completion Web UX. Workspace erasure is blocked at the
  database boundary until Stripe cancellation is confirmed or there is no
  subscription. Sales fail closed with `SALES_ENABLED=false`; the public price
  contract and Web explain that checkout is paused without creating a Stripe
  session. Live Stripe and approved legal copy remain human gates.
- PostgreSQL-backed opaque browser sessions and scoped PATs, email login and
  recovery, workspace authorization, two-user isolation, connection state,
  encrypted credential vaults, and executable Fastify API/worker composition.
- Scheduler, bounded retry/exhaustion recovery, transactional hosted projection,
  repair, commerce reconciliation, lifecycle export/deletion, audit events,
  redacted health surfaces, and independent least-privilege worker identities.
- V1--V15 forward-only database history now runs through a minimal Node/Postgres
  migrator with SHA-256 ledger, advisory serialization, transactional scripts,
  tamper/out-of-order/database-ahead rejection, and a verified one-time legacy
  Flyway import. Fresh, concurrent, no-op, tamper, rollback, and role-isolation
  tests pass.
- The production-composition canary exercises HTTPS, secure browser sessions,
  Stripe checkout/webhook/reconciliation, two users, Gmail and Outlook provider
  emulators, an actual HTTPS Basic OwnTracks endpoint, hosted ingestion,
  zero-lexical semantic retrieval, the real Rust tunnel with iMessage and
  WhatsApp, Web/installed CLI/official MCP result parity, one-use encrypted
  export, billing-safe deletion, erasure, and credential revocation.
- Vultr delivery is Docker Compose/Caddy only: GitHub Actions uses the strictly
  pinned `ssh botmem` transport, verifies keyless image signatures, performs an
  encrypted backup plus disposable restore, runs a loopback canary, and promotes
  atomically. Stable and canary Compose models, Caddy config, host scripts,
  ShellCheck, and actionlint pass. No Kubernetes path exists.
- Nine release images are built from pinned inputs with SBOM/signing workflows.
  Node runtimes are non-root and package-manager-free; the Botmem PostgreSQL/
  pgvector image rebuilds `gosu` with Go 1.26.5; the Botmem Caddy image rebuilds
  stock Caddy 2.11.4 with Go 1.26.5. Current local image scans report zero
  fixable high/critical findings for all nine images, and every generated
  CycloneDX SBOM parses with a non-empty component inventory.

## Open automated gates

- Push the scoped v2 branch and require every Botmem v2 pull-request CI job to
  pass on the exact review commit.
- After the reviewed commit reaches `main`, publish its signed multi-platform
  image digests and run the isolated loopback-only Vultr backup/restore/canary.
  Public Caddy/DNS promotion stays disabled until the human gates below pass.
- Run the prepared real-Chrome desktop/mobile/keyboard render script once the
  user enables Chrome's permissioned remote-debugging bridge. Unit/render-fixture
  contracts, 39 Web tests, production build/typecheck, and React Doctor 100/100
  are already green; a missing CDP target is not represented as a browser pass.

## Human-only final gates

- Approve and publish the legal entity, business address, contact, Terms,
  privacy disclosures, retention language, and applicable jurisdictional
  rights. Checkout remains technically disabled until that approval and an
  explicit `SALES_ENABLED=true` production change.
- Enable Chrome remote debugging at `chrome://inspect/#remote-debugging`, keep
  the real Chrome session running, and execute `pnpm test:web-render` for the
  final rendered desktop/mobile/keyboard evidence.
- Register production Google and Microsoft OAuth applications with exact deployed
  callbacks, then consent against real test mailboxes.
- Provide Apple Developer ID/notarization credentials and verify the final
  universal downloadable artifact with Gatekeeper on a clean supported Mac.
- Grant Full Disk Access through System Settings and validate real iMessage and
  WhatsApp databases after the automated preflight is green.
- Complete one real paid checkout/refund/cancel cycle after Stripe production
  configuration is wired and webhook fixtures pass; then request workspace
  deletion and verify the remote subscription is canceled before erasure.
- Store the backup `age` recovery identity in an independent recovery vault,
  confirm the main/tag/environment protection rules, and approve DNS/public
  Caddy cutover only after the isolated Vultr canary is green.
