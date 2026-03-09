---
phase: 21
slug: end-to-end-encryption-prod-core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                             |
| ---------------------- | --------------------------------- |
| **Framework**          | Vitest 3                          |
| **Config file**        | `apps/api/vitest.config.ts`       |
| **Quick run command**  | `pnpm --filter api test -- --run` |
| **Full suite command** | `pnpm test`                       |
| **Estimated runtime**  | ~15 seconds                       |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter api test -- --run`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement | Test Type | Automated Command                                                                  | File Exists        | Status  |
| -------- | ---- | ---- | ----------- | --------- | ---------------------------------------------------------------------------------- | ------------------ | ------- |
| 21-01-01 | 01   | 1    | E2EE-01     | unit      | `pnpm --filter api test -- --run src/crypto/__tests__/user-key.service.test.ts`    | No -- Wave 0       | pending |
| 21-01-02 | 01   | 1    | E2EE-02     | unit      | `pnpm --filter api test -- --run src/crypto/__tests__/crypto.service.test.ts`      | Partially (extend) | pending |
| 21-01-03 | 01   | 1    | E2EE-03     | unit      | `pnpm --filter api test -- --run src/memory/__tests__/enrich.processor.test.ts`    | Yes (extend)       | pending |
| 21-02-01 | 02   | 2    | E2EE-04     | unit      | `pnpm --filter api test -- --run src/memory/__tests__/reencrypt.processor.test.ts` | No -- Wave 0       | pending |

_Status: pending / green / red / flaky_

---

## Wave 0 Requirements

- [ ] `apps/api/src/crypto/__tests__/user-key.service.test.ts` — stubs for E2EE-01 (key derivation + in-memory storage)
- [ ] `apps/api/src/memory/__tests__/reencrypt.processor.test.ts` — stubs for E2EE-04 (batch re-encryption)
- [ ] Extended tests in `crypto.service.test.ts` for `encryptWithKey`/`decryptWithKey` methods

_Existing infrastructure covers framework and fixtures._

---

## Manual-Only Verifications

| Behavior                              | Requirement | Why Manual                               | Test Instructions                                                                                          |
| ------------------------------------- | ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sync jobs queue when no key in memory | E2EE-02     | Requires server restart + login sequence | 1. Restart server 2. Trigger sync (should queue) 3. Login 4. Verify sync resumes                           |
| IndexedDB key caching in browser      | E2EE-01     | Browser-side, not testable with Vitest   | 1. Login 2. Check IndexedDB has key 3. Refresh page 4. Verify key persists 5. Logout 6. Verify key cleared |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
