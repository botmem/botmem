---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Security, Auth & Encryption
status: executing
stopped_at: Phase 18 context gathered
last_updated: "2026-03-08T15:37:00.000Z"
last_activity: 2026-03-08 -- Phase 25 Plan 01 complete (source type reclassification)
progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 21
  completed_plans: 21
  percent: 24
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-08)

**Core value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.
**Current focus:** v2.1 Source Type Reclassification -- Phase 25

## Current Position

Phase: 25-source-type-reclassification (Plan 1 of 2)
Plan: 25-01 (complete)
Status: Executing
Last activity: 2026-03-08 -- Phase 25 Plan 01 complete (source type reclassification)

Progress: [██░░░░░░░░] 24%

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: 5min
- Total execution time: 23min

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 16 | 01 | 6min | 2 | 16 |
| 16 | 02 | 4min | 2 | 7 |
| 16 | 03 | 5min | 3 | 15 |
| 17 | 01 | 5min | 2 | 13 |
| 25 | 01 | 3min | 2 | 4 |

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

None yet.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-03-08T15:37:00.000Z
Stopped at: Completed 25-01-PLAN.md
Resume file: .planning/phases/25-source-type-reclassification/25-02-PLAN.md
