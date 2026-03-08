---
phase: 27
slug: data-backfill
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                               |
| ---------------------- | ----------------------------------- |
| **Framework**          | vitest 3                            |
| **Config file**        | `apps/api/vitest.config.ts`         |
| **Quick run command**  | `cd apps/api && pnpm test -- --run` |
| **Full suite command** | `pnpm test`                         |
| **Estimated runtime**  | ~15 seconds                         |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && pnpm test -- --run`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement | Test Type | Automated Command                            | File Exists | Status     |
| -------- | ---- | ---- | ----------- | --------- | -------------------------------------------- | ----------- | ---------- |
| 27-01-01 | 01   | 1    | BKF-01      | unit      | `cd apps/api && pnpm test -- --run backfill` | ❌ W0       | ⬜ pending |
| 27-01-02 | 01   | 1    | BKF-02      | unit      | `cd apps/api && pnpm test -- --run backfill` | ❌ W0       | ⬜ pending |
| 27-02-01 | 02   | 1    | BKF-03      | unit      | `cd apps/api && pnpm test -- --run backfill` | ❌ W0       | ⬜ pending |
| 27-02-02 | 02   | 1    | BKF-04      | unit      | `cd apps/api && pnpm test -- --run backfill` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `apps/api/src/memory/__tests__/backfill.processor.test.ts` — stubs for BKF-01, BKF-02
- [ ] `apps/api/src/memory/__tests__/backfill.controller.test.ts` — stubs for BKF-03, BKF-04

_Existing enrich pipeline tests cover entity extraction; backfill-specific tests needed for resumability and progress tracking._

---

## Manual-Only Verifications

| Behavior                         | Requirement | Why Manual                           | Test Instructions                                                     |
| -------------------------------- | ----------- | ------------------------------------ | --------------------------------------------------------------------- |
| WebSocket progress visible in UI | BKF-03      | Requires browser + running WebSocket | Start backfill, open browser, verify progress bar updates             |
| Connector filter dropdown works  | BKF-04      | UI interaction                       | Open backfill dialog, select connector type, verify filtered backfill |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
