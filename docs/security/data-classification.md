# Data Classification and Protection Levels

CASA Tier 2 self-attestation for ASVS 1.8.1, 1.8.2.

## Classification Levels

### CRITICAL -- Encryption + Access Control Required

| Data                  | Storage                             | Protection                                                                                                                                    |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| User passwords        | `users.password_hash`               | bcrypt (bcryptjs), 12 rounds. Timing-attack resistant: dummy hash compared when user not found.                                               |
| Recovery keys         | `users.recovery_key_hash`           | SHA-256 hash stored. Raw key (32 random bytes, base64-encoded) shown to user once at signup as mnemonic phrase. Never persisted in plaintext. |
| OAuth tokens          | `accounts.auth_context`             | AES-256-GCM encrypted with APP_SECRET-derived key. Wire format: `base64(iv):base64(ciphertext):base64(tag)`.                                  |
| Connector credentials | `connector_credentials.credentials` | AES-256-GCM encrypted (same scheme as OAuth tokens).                                                                                          |
| JWT secrets           | Environment variables only          | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OAUTH_JWT_SECRET` -- never stored in database.                                                    |
| APP_SECRET            | Environment variable only           | Server-level master key. Fatal warning if default value detected. Derived via scrypt into 256-bit AES key.                                    |

### SENSITIVE -- Per-User Encryption Required

| Data                  | Storage                               | Protection                                                                                                           |
| --------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Memory text           | `memories.text`                       | AES-256-GCM with per-user DEK (recovery key). Stale DEK detection triggers recovery key prompt.                       |
| Memory entities       | `memories.entities`                   | AES-256-GCM with per-user DEK.                                                                                       |
| Memory claims         | `memories.claims`                     | AES-256-GCM with per-user DEK.                                                                                       |
| Memory metadata       | `memories.metadata`                   | AES-256-GCM with per-user DEK.                                                                                       |
| Memory factuality     | `memories.factuality`                 | AES-256-GCM encrypted text (migrated from jsonb). Plaintext `factuality_label` column kept for SQL aggregation only. |
| Contact display names | `people.display_name`                 | Encrypted. `display_name_hash` (HMAC-SHA256) used as blind index for search.                                         |
| Contact identifiers   | `person_identifiers.identifier_value` | Encrypted. `identifier_value_hash` (HMAC-SHA256 blind index) for lookups without decryption.                         |
| Account identifiers   | `accounts.identifier`                 | Encrypted. `identifier_hash` (HMAC-SHA256 blind index) for search.                                                   |
| Raw event payloads    | `raw_events.payload`                  | Large JSON stored as text. Contains original connector data before normalization.                                    |
| Refresh tokens        | `refresh_tokens.token_hash`           | SHA-256 hashed (never stored plaintext). 7-day expiry. Token family tracking for rotation detection.                 |

### INTERNAL -- Access-Controlled Application Data

| Data                 | Storage                                | Protection                                                                                             |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Job metadata         | `jobs` table                           | Status, progress, error fields. Scoped by `account_id` -> `user_id` via RLS.                           |
| Connector manifests  | In-code `manifest` objects             | Static metadata (connector type, auth type, config schema). No secrets.                                |
| Sync state           | `accounts.last_cursor`, `last_sync_at` | Pagination cursors for incremental sync. Scoped by user.                                               |
| System configuration | `settings` table                       | Key-value pairs for system-level config.                                                               |
| Queue job payloads   | Redis (BullMQ)                         | Contains `accountId`, `memoryBankId`, job parameters. Redis on internal Docker network only.           |
| Memory banks         | `memory_banks` table                   | User-scoped grouping. `name_hash` HMAC blind index for encrypted name search.                          |
| Memory weights       | `memories.weights` (jsonb)             | Scoring metadata (semantic, recency, importance, trust). Not encrypted (no PII).                       |
| Search tokens        | `memories.search_tokens` (tsvector)    | Pre-computed from plaintext before encryption. Enables PostgreSQL full-text search without decryption. |

### PUBLIC -- No Protection Required

| Data                     | Endpoint                                          |
| ------------------------ | ------------------------------------------------- |
| API version + build info | `GET /api/version`                                |
| Health check             | `GET /api/health`                                 |
| Connector type list      | Returned in connector manifests (public metadata) |
| OpenAPI spec             | `GET /api/docs` (Swagger)                         |

## Key Management

### APP_SECRET (Server-Level Key)

- Set via `APP_SECRET` environment variable.
- Derived into 256-bit AES key via `scrypt(APP_SECRET, ENCRYPTION_SALT, 32)`.
- Separate HMAC key derived via `scrypt(APP_SECRET, 'botmem-hmac-v1', 32)`.
- Used for: connector credentials, OAuth tokens, Redis DEK cache wrapping.
- Default value triggers warning in dev, should be fatal in production.
- Rotation requires re-encrypting all server-encrypted columns.

### Per-User DEK (Data Encryption Key)

- Generated at signup: `crypto.randomBytes(32)` -- 256-bit random key.
- Recovery key = base64-encoded DEK, displayed to user once as mnemonic phrase.
- `users.recovery_key_hash` stores SHA-256 hash for verification.
- **2-tier cache** (no database tier for raw DEK):
  - **Tier 1 (Memory)**: In-process Map, 1-hour inactivity TTL. Buffer zeroed on eviction.
  - **Tier 2 (Redis)**: Encrypted with APP_SECRET (AES-256-GCM), 30-day TTL. Survives process restarts.
- If both caches are cold, user must re-enter recovery key via `POST /user-auth/recovery-key`.
- On module shutdown, all in-memory key buffers are zeroed (`Buffer.fill(0)`) before deletion.

### HMAC Blind Indexes

- Deterministic HMAC-SHA256 computed from plaintext using HMAC key (derived from APP_SECRET).
- Stored alongside encrypted values in `*_hash` columns.
- Enables equality search on encrypted fields without decryption.
- Used for: `accounts.identifier_hash`, `people.display_name_hash`, `person_identifiers.identifier_value_hash`, `memory_banks.name_hash`.

## Data Retention

- **Memories are never deleted** -- classified by factuality label (FACT / UNVERIFIED / FICTION) instead.
- **Raw events are immutable** -- original connector payloads preserved for audit and re-processing.
- **Refresh tokens** expire after 7 days. Revoked tokens remain in database for family rotation detection.
- **Password reset tokens** expire (configurable). Marked as used after consumption.
- **BullMQ jobs** retained in Redis with configurable TTL per queue.

## Encryption in Transit

- **External traffic**: TLS 1.2+ via Caddy with automatic Let's Encrypt certificates (ACME).
- **HSTS**: Enforced by Caddy configuration.
- **Internal traffic**: All data-zone services (PostgreSQL, Redis, Typesense, Qdrant) communicate over Docker internal network with no exposed ports. API-to-data connections are unencrypted loopback (acceptable per CASA for same-host Docker networking).
- **CORS**: Origin whitelist from `FRONTEND_URL` environment variable. Credentials allowed. Methods restricted to standard REST verbs.
- **WebSocket** (`/events`): Same origin policy, authenticated via JWT in connection handshake.

## Cipher Configuration (CASA 6.2.3)

- **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
- **IV**: 12 bytes (96 bits), cryptographically random per encryption operation
- **Auth tag**: 16 bytes (128 bits), appended to ciphertext for integrity verification
- **Mode**: GCM -- provides both confidentiality and authenticity. No ECB or CBC used.
- **Key derivation**: `scrypt(APP_SECRET, salt, keylen=32)` -- 256-bit key
- **Wire format**: `base64(iv):base64(ciphertext):base64(tag)`
- **Failure mode**: If GCM authentication fails, `decrypt()` throws -- never returns partial or corrupt plaintext (CASA 6.2.1).
- **Plaintext passthrough**: Data not matching the `iv:data:tag` format is returned as-is, supporting pre-encryption migration data gracefully.
