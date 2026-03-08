---
phase: 22
slug: postgresql-dual-driver
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                     |
| ---------------------- | ----------------------------------------- |
| **Framework**          | vitest 3.x                                |
| **Config file**        | apps/api/vitest.config.ts                 |
| **Quick run command**  | `pnpm --filter @botmem/api test -- --run` |
| **Full suite command** | `pnpm test`                               |
| **Estimated runtime**  | ~30 seconds                               |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @botmem/api test -- --run`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement  | Test Type   | Automated Command                         | File Exists | Status     |
| -------- | ---- | ---- | ------------ | ----------- | ----------------------------------------- | ----------- | ---------- |
| 22-01-01 | 01   | 1    | DB-01        | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0       | ⬜ pending |
| 22-01-02 | 01   | 1    | DB-02, DB-03 | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0       | ⬜ pending |
| 22-02-01 | 02   | 1    | DB-04        | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0       | ⬜ pending |
| 22-02-02 | 02   | 1    | DB-04        | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] Docker Compose with Postgres service for test environment
- [ ] Test fixtures for Postgres connection setup/teardown
- [ ] Existing test infrastructure covers vitest framework

_Note: Tests require a running Postgres instance (no in-memory equivalent to SQLite :memory:). Docker Compose provides this._

---

## Manual-Only Verifications

| Behavior                                                 | Requirement | Why Manual                  | Test Instructions                                                 |
| -------------------------------------------------------- | ----------- | --------------------------- | ----------------------------------------------------------------- |
| API starts with DATABASE_URL and responds on /api/health | DB-03       | Requires full app startup   | `docker compose up -d && pnpm dev`, verify /api/health returns ok |
| FTS search results quality (English + Arabic)            | DB-04       | Semantic quality assessment | Search for mixed-language terms, verify relevant results returned |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
