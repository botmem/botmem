---
phase: 30
slug: dev-workflow-fix
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 30 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3 |
| **Config file** | Per-package vitest configs |
| **Quick run command** | `pnpm test --filter=@botmem/api` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --filter=@botmem/api`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 30-01-01 | 01 | 1 | DEV-01 | manual | Manual: `pnpm dev` starts single process on port 12412 | N/A | ⬜ pending |
| 30-01-02 | 01 | 1 | DEV-02 | manual | Manual: edit shared file, observe API restart | N/A | ⬜ pending |
| 30-01-03 | 01 | 1 | DEV-03 | manual | Manual: new connector needs zero root script changes | N/A | ⬜ pending |
| 30-01-04 | 01 | 1 | DEV-04 | unit | `node -e "require('@botmem/shared')"` + Vite build check | ❌ W0 | ⬜ pending |
| 30-01-05 | 01 | 1 | DOCK-04 | unit | `pnpm vitest run apps/api/src/__tests__/health.controller.spec.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/__tests__/health.controller.spec.ts` — health endpoint unit test with mocked services (DOCK-04)
- [ ] Manual verification checklist for DEV-01, DEV-02, DEV-03 (infrastructure changes)

*Existing infrastructure covers test framework — no new framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| pnpm dev starts without port conflicts | DEV-01 | Requires process lifecycle verification | Run `pnpm dev`, confirm single API on :12412, no competing Vite |
| Library changes trigger API restart | DEV-02 | Requires watching file change propagation | Edit `packages/shared/src/types.ts`, observe API restart within 5s |
| New connector zero-config | DEV-03 | Requires creating new package | Create `packages/connectors/test-connector/`, run `pnpm dev` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
