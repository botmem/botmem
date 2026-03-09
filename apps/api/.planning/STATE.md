---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Security, Auth & Encryption
status: planning
stopped_at: Research phase
last_updated: "2026-03-08T14:00:00.000Z"
last_activity: 2026-03-08 -- Milestone v2.0 planning started
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-08)

**Core value:** Every piece of personal communication is searchable, connected, and queryable -- with factuality labeling so the user knows what's verified vs. hearsay.
**Current focus:** v2.0 Security, Auth & Encryption -- Research & planning

## Current Position

Phase: Pre-phase (research & planning)
Plan: N/A
Status: Planning
Last activity: 2026-03-08 -- Milestone v2.0 planning started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: N/A
- Total execution time: 0

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

### Pending Todos

None yet.

### Roadmap Evolution

- Phase 34 added: NestJS best practices maturation — input validation, rate limiting, transactions, structured logging, and security hardening

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-03-08T14:00:00.000Z
Stopped at: Research phase
Resume file: None
