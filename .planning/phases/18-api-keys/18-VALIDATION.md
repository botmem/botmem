---
phase: 18
slug: api-keys
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3 |
| **Config file** | `apps/api/vitest.config.ts` (workspace-level) |
| **Quick run command** | `cd apps/api && npx vitest run src/api-keys --reporter=verbose` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && npx vitest run src/api-keys -x`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 18-01-01 | 01 | 1 | KEY-01 | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/api-keys.service.test.ts -x` | ❌ W0 | ⬜ pending |
| 18-01-02 | 01 | 1 | KEY-01 | unit | same file | ❌ W0 | ⬜ pending |
| 18-01-03 | 01 | 1 | KEY-03 | unit | same file | ❌ W0 | ⬜ pending |
| 18-01-04 | 01 | 1 | KEY-04 | unit | same file | ❌ W0 | ⬜ pending |
| 18-01-05 | 01 | 1 | KEY-05 | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/dual-auth-guard.test.ts -x` | ❌ W0 | ⬜ pending |
| 18-01-06 | 01 | 1 | KEY-02 | unit | `cd apps/api && npx vitest run src/api-keys/__tests__/requires-jwt.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/api-keys/__tests__/api-keys.service.test.ts` — stubs for KEY-01, KEY-03, KEY-04
- [ ] `apps/api/src/api-keys/__tests__/dual-auth-guard.test.ts` — stubs for KEY-05
- [ ] `apps/api/src/api-keys/__tests__/requires-jwt.test.ts` — stubs for KEY-02

*Existing infrastructure covers framework setup. Only test files needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Settings page API Keys tab renders | KEY-04 | Frontend UI | Navigate to Settings > API Keys, verify list renders |
| Create key modal shows once-only secret | KEY-01 | Frontend UX | Create a key, verify secret shown, close modal, verify masked |
| Copy button copies to clipboard | KEY-01 | Browser API | Click copy, paste in text field, verify match |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
