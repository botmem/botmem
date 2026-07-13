# Product contract

## Purpose

Botmem is a personal context layer that searches hosted remote data and
device-local data through one API, usable identically from the Web app, CLI, and
MCP-compatible agents.

The first release succeeds when a new customer can install, connect all five
launch sources, search them together, use the same results from all three
clients, pay, export, and delete their account without operator intervention.

## Source placement

| Source    | Authentication                                                        | Storage and search |
| --------- | --------------------------------------------------------------------- | ------------------ |
| Gmail     | Server-owned OAuth 2.0 application                                    | Hosted             |
| Outlook   | Server-owned Microsoft OAuth 2.0 application                          | Hosted             |
| OwnTracks | HTTPS Basic auth to a user-provided endpoint                          | Hosted             |
| iMessage  | macOS TCC approval in signed Botmem app                               | Device-local       |
| WhatsApp  | User pairs in WhatsApp Desktop; Botmem receives no session credential | Device-local       |

There is no server-side or Botmem-owned WhatsApp session and no Node-based local
reader. The signed Mac app and Rust core verify the user-owned WhatsApp Desktop
store, supported schema, Full Disk Access, and a real read-only SQLite handle.
Only Botmem's derived index is written, and it remains on the Mac.

## One public behavior

Web, CLI, and MCP are adapters over the same versioned application ports. They
must produce the same ordered IDs, provenance, filters, partial-lane state, and
authorization behavior. Private client-side score thresholds are prohibited.

The first MCP surface is deliberately read-only:

- `search`
- `connections.list`
- `devices.status`

Conversational answers, memory writes, and source-specific agent tools are not
launch requirements.

## Search behavior

- Hosted and all eligible online device lanes run concurrently.
- Each lane has a bounded deadline and reports its own state.
- Raw scores from different search engines are never compared.
- Ordered lane results are fused with deterministic reciprocal-rank fusion.
- Results deduplicate on durable source identity and retain provenance.
- Launch search returns one bounded result set (maximum 100) and has no public
  pagination cursor. This prevents hosted cursor state from retaining local
  message snippets; users refine the query or filters for additional results.
- Device failure or absence returns hosted results with `partial: true`.
- Hosted failure may still return device results with `partial: true`.
- Filters apply identically across lanes; unsupported filters are validation
  errors, not silently ignored.
- Arabic and English text are launch languages.

## Data promises

- Remote sync accepts every item permitted by the granted provider scope. Query
  and presentation policies may hide noise; ingestion may not permanently drop
  it.
- `(account_id, source_id, revision)` identifies an immutable remote event.
- Cursor advancement happens only after durable event and outbox commit.
- Hosted connector schedules survive worker restarts. Exhausted transient
  failures enter a bounded long cooldown and then receive a fresh probe cycle;
  revoked credentials and other permanent failures remain terminal until the
  user reconnects.
- Projection work is idempotent and automatically repairs interrupted work.
- People are linked only by durable identifiers such as email, phone, or
  provider user ID. Extracted names are search terms, never identity evidence.
- Local content and indexes are not stored remotely. Relayed query/result bodies
  are neither logged nor cached.
- Account exports are hosted-content-only NDJSON and remain downloadable until
  their displayed expiry time; a dropped HTTP connection never consumes the
  only download attempt. Every hosted event is exported losslessly. Records
  larger than the artifact writer's line limit are represented by contiguous
  `hosted_event_chunk` records whose base64url payload reconstructs the exact
  original `hosted_event` line and whose SHA-256 digest verifies it. The export
  manifest declares this encoding. Device-local iMessage and WhatsApp content
  is excluded because copying it to the server would violate the product's
  storage boundary.
- The signed Mac app owns one background incremental scheduler. Launch, wake,
  activation after permission changes, and bounded periodic/retry triggers are
  single-flight and coalesced. Per-source schedule state survives restart in the
  private app configuration; high-water cursors survive in Rust's local index.

## Honest exclusions

The launch product does not include Slack, Telegram, photos, external plugins,
people graphs, claims/factuality, timelines, or an LLM answer layer. These may
return only after the five-source setup-to-search path meets every release gate.
