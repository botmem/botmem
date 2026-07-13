# Botmem v2

Botmem v2 is the production rewrite of Botmem: one personal-context search layer
for hosted remote data and device-local data, exposed consistently to people and
agents.

The legacy repository is evidence, not the v2 architecture. V2 reuses proven
parsers, test fixtures, migrations inputs, and visual tokens only when they fit
the contracts in this directory.

## Launch scope

- Hosted: Gmail and Outlook through server-owned OAuth applications.
- Hosted: OwnTracks through HTTPS Basic authentication with SSRF protection.
- Device-local: iMessage and WhatsApp through the signed Rust-powered Mac app.
- Access: one versioned search/status/connection contract used by Web, CLI, and
  MCP.
- Product: onboarding, subscription, export, disconnect, and account deletion.

Slack, Telegram, photos, graph inference, conversational RAG, write-capable
agent memory, and external plugins are deliberately out of the first release.

## Privacy boundary

Remote connector content is processed and indexed in access-controlled hosted
PostgreSQL; it is not zero knowledge and application-level content encryption
is not claimed. Connector credentials and export/backup artifacts are encrypted,
and network paths require TLS.

iMessage and WhatsApp corpora and indexes remain on the user's device. Users
pair WhatsApp in WhatsApp Desktop; Botmem reads that user-owned local store
read-only and never receives or copies the WhatsApp session credential. A search
query and the selected matching result payloads transit an outbound TLS tunnel
after signed device authentication; they are not persisted or logged by the relay.
Offline devices produce explicit partial search results.

## Workspace

This is an isolated pnpm and Cargo workspace. It will not import application
code from the first attempt.

```text
apps/
  api/              Gateway and worker entrypoints from one modular-monolith image
  web/              Browser application generated against the public contract
packages/
  contracts/        Versioned wire contracts and runtime validation
  search-domain/    Framework-free federated search domain and ports
  connector-domain/ Framework-free account, cursor and ingestion invariants
  testkit/          Deterministic cross-source corpus and contract fixtures
crates/
  device-core/      Rust local adapters, safe index, search and tunnel protocol
macos/
  Botmem/            Swift shell: Keychain, TCC, lifecycle and device pairing
```

Read [the product contract](docs/product-contract.md), [architecture](docs/architecture.md),
the [release gates](docs/acceptance.md), and the live
[release scorecard](docs/release-scorecard.md) before changing scope.
