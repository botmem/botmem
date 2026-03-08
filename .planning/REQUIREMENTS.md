# Requirements: Botmem

**Core Value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.

## v2.0 Requirements -- Security, Auth & Encryption

**Defined:** 2026-03-08

### User Auth (Open-Core) — always required, no bypass

- [ ] **AUTH-01**: Register with email + password (bcrypt hash, minimum 8 chars)
- [ ] **AUTH-02**: Login → JWT access token (15min) + httpOnly refresh cookie (7d)
- [ ] **AUTH-03**: Refresh access token via `POST /auth/refresh` using refresh cookie
- [ ] **AUTH-04**: Password reset via email link (cryptographic token, 1hr expiry)
- [ ] **AUTH-05**: Session persistence via refresh token rotation (old token invalidated on use)

### Firebase Auth (Prod-Core)

- [ ] **FBAUTH-01**: NestJS guard verifies Firebase ID tokens via `firebase-admin` SDK
- [ ] **FBAUTH-02**: React login/register UI with Firebase client SDK (email+password, Google, GitHub)
- [ ] **FBAUTH-03**: `AUTH_PROVIDER=local|firebase` env var selects auth provider at startup
- [ ] **FBAUTH-04**: Firebase social login (Google, GitHub) available in prod-core only

### API Security

- [ ] **SEC-01**: Auth guard on all endpoints (except `/health`, `/version`, `/auth/*`)
- [ ] **SEC-02**: CORS locked to `FRONTEND_URL` origin(s), credentials mode enabled

### API Keys

- [ ] **KEY-01**: Create multiple named API keys per user (cryptographic generation, stored hashed)
- [ ] **KEY-02**: All API keys are read-only (search, list memories/contacts — no writes, no sync, no delete)
- [ ] **KEY-03**: Keys scoped to specific memory bank(s) at creation time
- [ ] **KEY-04**: List and revoke API keys via authenticated endpoints
- [ ] **KEY-05**: API keys authenticate via `Authorization: Bearer <key>` header, coexist with JWT auth

### Memory Banks

- [ ] **BANK-01**: Create, list, rename, and delete memory banks per user
- [ ] **BANK-02**: Select target memory bank at sync time (connector sync config)
- [ ] **BANK-03**: Search scoped to accessible bank(s) — user's own banks + API key bank scope
- [ ] **BANK-04**: Default bank created on registration + migration of existing data into default bank

### Encryption at Rest (Open-Core)

- [ ] **ENC-01**: AES-256-GCM encryption for `authContext` (accounts table) and `connectorCredentials` table, key derived from `APP_SECRET` env var
- [ ] **ENC-02**: Migration script to encrypt existing plaintext credentials with zero downtime

### E2EE (Prod-Core)

- [ ] **E2EE-01**: Encryption key derived from user password via Argon2id (client-side, in browser)
- [ ] **E2EE-02**: Memory text + metadata encrypted client-side before storage (server never sees plaintext)
- [ ] **E2EE-03**: Embedding vectors stay plaintext (semantic search continues to work)
- [ ] **E2EE-04**: Password change re-derives key + re-encrypts all user memories (batched, resumable)

### Database

- [ ] **DB-01**: PostgreSQL schema (`schema.pg.ts`) mirrors SQLite schema with identical logical structure
- [ ] **DB-02**: Shared database interface abstracts over SQLite and PostgreSQL (application code is dialect-agnostic)
- [ ] **DB-03**: Conditional DbService initializes correct driver based on `DB_DRIVER=sqlite|postgres` env var
- [ ] **DB-04**: SQLite FTS5 ported to PostgreSQL tsvector + GIN index for full-text search
- [ ] **DB-05**: PostgreSQL RLS policies isolate user data — each user sees only their own memories, accounts, contacts

### v2.0 Out of Scope

| Feature | Reason |
|---------|--------|
| OAuth social login on open-core | Firebase handles social login for prod-core only |
| Write-capable API keys | Read-only is sufficient for agent/CLI use; writes require full auth |
| Multi-tenancy admin dashboard | Single-user focus; admin features deferred |
| Docker/Caddy/CI-CD deployment | Deferred to v3.0 |
| OpenRouter inference abstraction | Deferred to v3.0 |
| Rate limiting | Can be added later without architectural changes |
| Key escrow / recovery | Zero-knowledge design: lost password = lost data (by design) |

### v2.0 Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 16 | Pending |
| AUTH-02 | Phase 16 | Pending |
| AUTH-03 | Phase 16 | Pending |
| AUTH-04 | Phase 16 | Pending |
| AUTH-05 | Phase 16 | Pending |
| SEC-01 | Phase 17 | Pending |
| SEC-02 | Phase 17 | Pending |
| KEY-01 | Phase 18 | Pending |
| KEY-02 | Phase 18 | Pending |
| KEY-03 | Phase 18 | Pending |
| KEY-04 | Phase 18 | Pending |
| KEY-05 | Phase 18 | Pending |
| BANK-01 | Phase 19 | Pending |
| BANK-02 | Phase 19 | Pending |
| BANK-03 | Phase 19 | Pending |
| BANK-04 | Phase 19 | Pending |
| ENC-01 | Phase 20 | Pending |
| ENC-02 | Phase 20 | Pending |
| E2EE-01 | Phase 21 | Pending |
| E2EE-02 | Phase 21 | Pending |
| E2EE-03 | Phase 21 | Pending |
| E2EE-04 | Phase 21 | Pending |
| DB-01 | Phase 22 | Pending |
| DB-02 | Phase 22 | Pending |
| DB-03 | Phase 22 | Pending |
| DB-04 | Phase 22 | Pending |
| DB-05 | Phase 23 | Pending |
| FBAUTH-01 | Phase 24 | Pending |
| FBAUTH-02 | Phase 24 | Pending |
| FBAUTH-03 | Phase 24 | Pending |
| FBAUTH-04 | Phase 24 | Pending |

**v2.0 Coverage:**
- v2.0 requirements: 30 total (AUTH: 5, FBAUTH: 4, SEC: 2, KEY: 5, BANK: 4, ENC: 2, E2EE: 4, DB: 5)
- Mapped to phases: 30 (Phases 16-24, skipping FBAUTH to end)
- Unmapped: 0

## Previous Milestones (Completed)

### v1.4 -- Search Intelligence (Complete)

- [x] ENT-01, ENT-02, ENT-03 (Entity Classification)
- [x] NLQ-01, NLQ-02, NLQ-03 (NLQ Parsing)
- [x] PERF-01 (Search Performance)
- [ ] CIT-01 (Source Citations — deferred)

### v1.3 -- Test Coverage (Complete)

- [x] Test infrastructure fixes

### v1.2 -- PostHog Deep Analytics (Complete)

- [x] REPLAY-01-03, HEAT-01-03, ERR-01-03, WEB-01-03, PROD-01-03, ID-01-02

### v1.1 -- PostHog Analytics Activation (Complete)

- [x] CFG-01-02, VER-01-05, COV-01-02

## Future Requirements

Deferred to future releases. Tracked but not in current roadmap.

### v3.0 — Production Deployment & CI/CD

- **DEP-01**: Vultr VPS provisioning with Docker and swap
- **DEP-02**: Multi-stage Dockerfile for API + web
- **DEP-03**: `docker-compose.prod.yml` with Postgres, Redis, Qdrant, Caddy
- **DEP-04**: Caddyfile with automatic Let's Encrypt SSL
- **DEP-05**: DNS A record for botmem.xyz
- **CICD-01**: GitHub Actions for open-core (lint, test, build)
- **CICD-02**: GitHub Actions for prod-core (lint, test, build, deploy)
- **CICD-03**: SSH deployment pipeline
- **INF-01**: InferenceService interface (Ollama/OpenRouter)
- **INF-02-05**: Provider implementations and fallback scoring

### Monitoring & Operations

- **OPS-01**: Uptime monitoring and alerting
- **OPS-02**: Log aggregation from Docker containers
- **OPS-03**: Automated PostgreSQL backup schedule
- **OPS-04**: Blue-green or rolling deployment strategy

## Out of Scope

| Feature | Reason |
|---------|--------|
| Kubernetes / container orchestration | Single VPS is sufficient at this scale |
| Custom domain per user | Single-tenant production deployment |
| CDN / edge caching | Unnecessary for single-user production instance |
| Multi-region deployment | Single VPS, single region |
| Key escrow / password recovery | Zero-knowledge E2EE by design |

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after v2.0 milestone start*
