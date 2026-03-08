---
phase: 28
slug: verification
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 28 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| **Framework**          | vitest 3 (unit) + live API queries (integration)          |
| **Config file**        | `apps/api/vitest.config.ts`                               |
| **Quick run command**  | `cd apps/api && pnpm test -- --run`                       |
| **Full suite command** | `pnpm test`                                               |
| **Estimated runtime**  | ~15 seconds (unit); integration requires running services |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && pnpm test -- --run`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement | Test Type   | Automated Command                                | File Exists | Status     |
| -------- | ---- | ---- | ----------- | ----------- | ------------------------------------------------ | ----------- | ---------- |
| 28-01-01 | 01   | 1    | VER-01      | integration | `cd apps/api && pnpm test -- --run verification` | ❌ W0       | ⬜ pending |
| 28-01-02 | 01   | 1    | VER-02      | integration | `cd apps/api && pnpm test -- --run verification` | ❌ W0       | ⬜ pending |
| 28-01-03 | 01   | 1    | VER-03      | integration | `cd apps/api && pnpm test -- --run verification` | ❌ W0       | ⬜ pending |
| 28-01-04 | 01   | 1    | VER-04      | integration | `cd apps/api && pnpm test -- --run verification` | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `apps/api/src/memory/__tests__/verification.test.ts` — integration test stubs for VER-01 through VER-04

_Phase 28 is verification-only — tests ARE the deliverable._

---

## Manual-Only Verifications

| Behavior                           | Requirement | Why Manual                                    | Test Instructions                                                |
| ---------------------------------- | ----------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Memory graph visual correctness    | VER-03      | Requires visual inspection of graph rendering | Open graph view, verify no garbage nodes, correct entity types   |
| NLQ query natural language parsing | VER-04      | Requires running Ollama for NLQ               | Query "show me photos from last week", verify source_type filter |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
