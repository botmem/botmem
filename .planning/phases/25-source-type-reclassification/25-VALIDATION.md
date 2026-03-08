---
phase: 25
slug: source-type-reclassification
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3 |
| **Config file** | `apps/api/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @botmem/api test -- --run` |
| **Full suite command** | `pnpm --filter @botmem/api test -- --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @botmem/api test -- --run`
- **After every plan wave:** Run `pnpm --filter @botmem/api test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 25-01-01 | 01 | 1 | SRC-01 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 25-01-02 | 01 | 1 | SRC-02 | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 25-01-03 | 01 | 1 | SRC-03 | integration | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 25-01-04 | 01 | 1 | SRC-04 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/memory/__tests__/source-type-reclassification.test.ts` — stubs for SRC-01 through SRC-04
- [ ] Test fixtures for mock photo memories with `source_type: 'file'`

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Qdrant payload update | SRC-03 | Requires live Qdrant instance | Run backfill migration, query Qdrant for photo memories, verify `source_type` field |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
