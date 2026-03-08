---
phase: 34
slug: nestjs-best-practices-maturation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 34 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3 |
| **Config file** | apps/api/vitest.config.ts |
| **Quick run command** | `pnpm --filter @botmem/api test -- --run` |
| **Full suite command** | `pnpm --filter @botmem/api test -- --run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @botmem/api test -- --run`
- **After every plan wave:** Run `pnpm --filter @botmem/api test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 34-01-01 | 01 | 1 | validation | unit | `pnpm --filter @botmem/api test -- --run` | ✅ existing tests | ⬜ pending |
| 34-01-02 | 01 | 1 | rate-limiting | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 34-02-01 | 02 | 1 | transactions | unit | `pnpm --filter @botmem/api test -- --run` | ✅ existing tests | ⬜ pending |
| 34-02-02 | 02 | 1 | logging | manual | verify Logger replaces console | ✅ | ⬜ pending |
| 34-03-01 | 03 | 2 | security | unit | `pnpm --filter @botmem/api test -- --run` | ❌ W0 | ⬜ pending |
| 34-03-02 | 03 | 2 | error-handling | unit | `pnpm --filter @botmem/api test -- --run` | ✅ existing tests | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing test infrastructure covers most requirements
- New tests needed for: validation pipe behavior, throttler rejection, production secret validation

*Existing infrastructure covers core phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Logger output format | logging | Console output visual check | Run `pnpm dev`, check log format includes class names |
| Rate limiting in practice | rate-limiting | Requires rapid HTTP requests | `curl` loop against login endpoint, verify 429 response |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
