---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Security, Auth & Encryption
status: Defining requirements
stopped_at: Completed 25-02-PLAN.md (Phase 25 complete)
last_updated: "2026-03-08T15:43:38.696Z"
last_activity: 2026-03-08 — Milestone v3.0 started
progress:
  total_phases: 21
  completed_phases: 12
  total_plans: 25
  completed_plans: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-08)

**Core value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.
**Current focus:** v3.0 Monorepo & Developer Experience -- Defining requirements

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-03-08 — Milestone v3.0 started

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 4min
- Total execution time: 24min

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 16 | 01 | 6min | 2 | 16 |
| 16 | 02 | 4min | 2 | 7 |
| 16 | 03 | 5min | 3 | 15 |
| 17 | 01 | 5min | 2 | 13 |
| 25 | 01 | 3min | 2 | 4 |
| 25 | 02 | 1min | 1 | 1 |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v2.0]: Auth always on -- no dev bypass, even open-core requires login
- [v2.0]: Open-core = local email+password+JWT; Prod-core = Firebase (Google/GitHub social)
- [v2.0]: E2EE encrypts text+metadata only; vectors stay plaintext for search
- [v2.0]: Encryption key derived from user password (Argon2id) -- lost password = lost data
- [v2.0]: Memory bank selected at sync time (not auto-assigned per connector)
- [v2.0]: PostgreSQL included because RLS depends on it
- [v2.0]: Phase numbering continues from 15 (starts at 16)
- [Phase 16]: Access token in memory only -- never persisted; session restored via httpOnly refresh cookie
- [Phase 16]: 401 interceptor uses mutex Promise to prevent concurrent refresh races
- [Phase 16]: Password reset token stored as SHA-256 hash with 1hr expiry; existing unused tokens invalidated

### Decisions (Phase 16)

- [16-01]: Separate jwtAccessSecret/jwtRefreshSecret instead of single JWT_SECRET for defense-in-depth
- [16-01]: SHA-256 hash of refresh token stored in DB, raw token never persisted
- [16-01]: Dummy bcrypt hash comparison on non-existent users prevents timing-based email enumeration
- [16-01]: Token family UUID tracks refresh chain -- replaying revoked token kills entire family
- [16-02]: Lazy nodemailer transporter -- only create SMTP connection on first send
- [16-02]: Graceful mail failure -- log errors but never throw from sendResetEmail
- [16-02]: Console fallback in dev -- log reset URL to stdout when SMTP not configured

### Decisions (Phase 17)

- [17-01]: CORS supports comma-separated FRONTEND_URL for multi-origin deployments
- [17-01]: WebSocket auth via token query param (not header) for browser WebSocket API compatibility
- [17-01]: WsClient refuses to connect without token -- prevents pre-auth connection attempts

### Decisions (Phase 25)

- [25-01]: Migration scripts use main().catch() pattern instead of top-level await for tsx CJS compatibility

### Pending Todos

None yet.

### Roadmap Evolution

- v2.0 paused at 26% (phases 16-17 complete, 25 complete, 18-24 + 26-28 remaining)
- v3.0 inserted for monorepo/DX work before resuming security milestone

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-03-08T15:40:00.000Z
Stopped at: Completed 25-02-PLAN.md (Phase 25 complete)
Resume file: .planning/phases/26-entity-format-quality/
