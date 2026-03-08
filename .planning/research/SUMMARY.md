# Research Summary: Botmem v2.0 Security, Auth & Encryption

**Domain:** User auth, API keys, memory banks, encryption at rest, E2EE, PostgreSQL + RLS for personal memory RAG system
**Researched:** 2026-03-08
**Overall confidence:** HIGH

## Executive Summary

Botmem currently has **zero authentication** — all API endpoints are open, CORS is unrestricted, the frontend `authStore` does plaintext password comparison in localStorage, and "encrypted" fields in the schema are stored as plaintext. This milestone transforms it into a properly secured system.

The stack additions are well-understood NestJS patterns. The auth layer uses `@nestjs/jwt` + `@nestjs/passport` (official NestJS packages), bcrypt for password hashing, and the standard global guard + `@Public()` decorator pattern. The only architecturally novel pieces are: (1) memory banks as a data isolation concept, (2) E2EE with client-side Argon2id key derivation, and (3) PostgreSQL RLS policies working through Drizzle ORM.

The biggest risk is the E2EE password change flow — re-encrypting all memories when a user changes their password requires careful batching, progress tracking, and crash recovery. The second risk is RLS bypass through connection pooling (Drizzle + pg must `SET LOCAL` the user context on every request within a transaction).

## Key Findings

**Stack:** `@nestjs/jwt@^11`, `@nestjs/passport@^11`, `bcrypt@^5`, `passport-jwt@^4`, `passport-local@^1`, `firebase-admin@^13` (prod-core), `drizzle-orm/pg-core` + `postgres` (js driver). Node.js `crypto` module for AES-256-GCM (no external library needed). `argon2-browser` or `hash-wasm` for client-side Argon2id in WebAssembly.

**Architecture:**
- Global `APP_GUARD` with `@Public()` decorator for health/version/auth endpoints
- Existing `auth/` module handles connector OAuth — user auth goes in a new `user-auth/` module to avoid conflicts
- API keys coexist with JWT: guard checks `Authorization: Bearer` header, determines if token is JWT or API key by format (API keys have a `bmk_` prefix)
- Memory banks are a `banks` table with `userId` FK; memories get `bankId` FK; Qdrant uses payload filter (not collection-per-bank)
- Dual DB driver: `schema.ts` (SQLite) and `schema.pg.ts` (Postgres) with a shared `DbInterface` type that abstracts queries
- RLS requires `SET LOCAL app.current_user_id` at the start of each request transaction

**Critical pitfalls:**
- JWT refresh token rotation race conditions (concurrent 401 responses) — need frontend mutex + backend grace period
- AES-GCM IV reuse is catastrophic — always use `crypto.randomBytes(12)` per encryption, never derive IV from data
- RLS bypass via connection pooling — must use per-request transactions with `SET LOCAL`, not session-level `SET`
- E2EE password change partial failure — need resumable batch re-encryption with progress checkpoint
- Firebase token verification requires clock sync — use `clockTolerance` option

## Implications for Roadmap

The 9-phase structure (16-24) is well-supported by research:

1. **Phase 16 (User Auth)** — Standard NestJS pattern, lowest risk. New `user-auth/` module, `users` table, bcrypt + JWT.
2. **Phase 17 (API Security)** — Global guard + `@Public()`, CORS lockdown. Small phase, high impact.
3. **Phase 18 (API Keys)** — `apiKeys` table with SHA-256 hashed keys, `bmk_` prefix for identification, read-only enforcement in guard.
4. **Phase 19 (Memory Banks)** — `banks` table, `bankId` on memories, Qdrant payload filter, default bank migration.
5. **Phase 20 (Encryption at Rest)** — `crypto.createCipheriv('aes-256-gcm')` for authContext/credentials, key from `APP_SECRET`. Migration script.
6. **Phase 21 (E2EE)** — Highest risk phase. Client-side Argon2id + AES-256-GCM. Password change re-encryption is the hard part.
7. **Phase 22 (PostgreSQL)** — `schema.pg.ts` + `postgres` driver + shared interface. FTS5→tsvector migration.
8. **Phase 23 (RLS)** — RLS policies + per-request `SET LOCAL`. Depends on Phase 22 + Phase 16.
9. **Phase 24 (Firebase)** — `AUTH_PROVIDER` env var switches guard strategy. Social login (Google, GitHub).

**Research flags:**
- Phase 16: Standard pattern, no research needed during planning
- Phase 19: Memory bank migration (moving existing data) needs careful testing
- Phase 21: E2EE password change flow needs detailed design — flag for research
- Phase 22: Drizzle dual-driver abstraction needs prototyping — some queries may need dialect-specific handling
- Phase 23: RLS + Drizzle interaction needs testing — verify ORM doesn't bypass policies

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All packages are mature, well-documented, NestJS-native |
| Features | HIGH | Standard auth patterns, well-understood implementation |
| Architecture | HIGH | Clear integration points, existing codebase analyzed |
| Pitfalls | HIGH | Based on real-world NestJS security incidents + codebase analysis |
| E2EE | MEDIUM | Client-side Argon2id + re-encryption on password change has edge cases |
| RLS + Drizzle | MEDIUM | Limited community examples of RLS with Drizzle ORM specifically |

## Gaps to Address

- **E2EE key management UX**: What happens when user forgets password? (Answer: data is lost by design — need clear UX warning)
- **Drizzle + RLS integration**: Need prototype to verify Drizzle ORM queries work correctly with RLS enabled and `SET LOCAL`
- **Email delivery**: Password reset requires sending email — need to choose transactional email provider (Resend, SendGrid, etc.)
- **WebSocket auth**: Current EventsGateway accepts all connections — needs JWT validation in handshake
