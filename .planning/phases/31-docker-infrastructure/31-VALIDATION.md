---
phase: 31
slug: docker-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 31 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification + shell commands |
| **Config file** | N/A (infrastructure, not application code) |
| **Quick run command** | `docker compose up -d --wait && docker compose ps` |
| **Full suite command** | `make dev` (verify infra + app starts) |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `docker compose config --quiet` (validates compose syntax)
- **After every plan wave:** Run `docker compose up -d --wait && docker compose ps`
- **Before `/gsd:verify-work`:** Full `make dev` must start everything
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 31-01-01 | 01 | 1 | DOCK-01 | smoke | `docker compose up -d --wait && docker compose ps \| grep healthy` | N/A | ⬜ pending |
| 31-01-02 | 01 | 1 | DOCK-01 | smoke | `docker compose --profile ollama up -d --wait && docker compose ps \| grep ollama` | N/A | ⬜ pending |
| 31-01-03 | 01 | 1 | DOCK-01 | manual | Inspect docker-compose.yml for `:latest` absence | N/A | ⬜ pending |
| 31-01-04 | 01 | 1 | DOCK-02 | smoke | `make dev` then verify :12412 responds | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements — this phase creates infrastructure files, not application code.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Pinned image versions | DOCK-01 | Static file inspection | Check docker-compose.yml has no `:latest` tags |
| make dev end-to-end | DOCK-02 | Requires full stack lifecycle | Run `make dev`, verify API on :12412 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
