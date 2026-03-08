---
phase: 26
slug: entity-format-quality
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3 |
| **Config file** | apps/api/vitest.config.ts |
| **Quick run command** | `pnpm --filter @botmem/api test -- --run` |
| **Full suite command** | `pnpm --filter @botmem/api test -- --run` |
| **Estimated runtime** | ~8 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @botmem/api test -- --run`
- **After every plan wave:** Run `pnpm --filter @botmem/api test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 1 | FMT-01 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 26-01-02 | 01 | 1 | ENT-01, ENT-02, ENT-03 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 26-02-01 | 02 | 2 | FMT-02, FMT-03 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 26-02-02 | 02 | 2 | ENT-04, ENT-05 | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/memory/__tests__/normalize-entities.test.ts` — unit tests for normalizer pure function
- [ ] `apps/api/src/memory/__tests__/enrich-entities.test.ts` — integration tests for entity dedup and link existence checks

*Existing vitest infrastructure covers framework needs. Only test files need creation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Entities display correctly in Memory Explorer UI | FMT-01 | UI rendering | Search a memory, verify entity chips show correct type/value |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
