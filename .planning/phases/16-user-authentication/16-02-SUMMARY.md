---
phase: 16-user-authentication
plan: 02
subsystem: auth
tags: [nodemailer, smtp, password-reset, mail, nestjs]

# Dependency graph
requires:
  - phase: none
    provides: standalone infrastructure
provides:
  - passwordResets table in schema.ts
  - MailService with SMTP and console-log fallback
  - MailModule exported for DI injection
  - SMTP config getters on ConfigService
affects: [16-03-frontend-auth, 16-01-backend-auth]

# Tech tracking
tech-stack:
  added: [nodemailer]
  patterns: [lazy transporter init, graceful mail failure, console fallback for dev]

key-files:
  created:
    - apps/api/src/mail/mail.service.ts
    - apps/api/src/mail/mail.module.ts
    - apps/api/src/mail/__tests__/mail.service.test.ts
  modified:
    - apps/api/src/db/schema.ts
    - apps/api/src/config/config.service.ts
    - apps/api/src/app.module.ts
    - apps/api/package.json

key-decisions:
  - "Lazy transporter creation -- only creates nodemailer transport on first actual send"
  - "Graceful failure -- sendResetEmail catches errors and logs, never throws"
  - "Console fallback -- dev mode logs reset URL to stdout instead of requiring SMTP"
  - "Added users and refreshTokens tables alongside passwordResets since Plan 01 was not yet committed"

patterns-established:
  - "Mail fallback: console.log in dev, SMTP in production"
  - "Graceful mail errors: log but do not throw on send failure"

requirements-completed: [AUTH-04]

# Metrics
duration: 4min
completed: 2026-03-08
---

# Phase 16 Plan 02: Password Reset Infrastructure Summary

**MailService with nodemailer SMTP transport and console fallback, passwordResets table, and SMTP config getters**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-08T13:31:09Z
- **Completed:** 2026-03-08T13:35:46Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- passwordResets table defined in schema with userId FK, tokenHash, expiresAt, usedAt
- MailService sends password reset emails via nodemailer when SMTP configured
- Console fallback logs reset URL when SMTP not configured (dev mode)
- SMTP config getters (host, port, user, pass, from, configured) added to ConfigService
- 3 tests covering SMTP mode, console mode, and graceful error handling

## Task Commits

Each task was committed atomically:

1. **Task 1: Add passwordResets table and SMTP config** - `efaa3bc` (feat)
2. **Task 2: Create MailService and password reset service methods** - `ae4867b` (feat)

## Files Created/Modified
- `apps/api/src/db/schema.ts` - Added users, refreshTokens, passwordResets tables
- `apps/api/src/config/config.service.ts` - Added SMTP and JWT config getters
- `apps/api/src/mail/mail.service.ts` - MailService with sendResetEmail (SMTP + console fallback)
- `apps/api/src/mail/mail.module.ts` - NestJS module exporting MailService
- `apps/api/src/mail/__tests__/mail.service.test.ts` - 3 tests for mail service
- `apps/api/src/app.module.ts` - Added MailModule to imports
- `apps/api/package.json` - Added nodemailer dependency

## Decisions Made
- Used lazy transporter initialization to avoid creating SMTP connections when not needed
- sendResetEmail catches all errors and logs them -- the reset endpoint should succeed even if email delivery fails
- In dev mode (no SMTP config), the reset URL is logged to console so developers can access it
- Added users and refreshTokens tables since Plan 01 had not committed yet (parallel execution); Plan 01 later overwrote with its own version which includes additional fields (name, onboarded, family)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added users and refreshTokens tables**
- **Found during:** Task 1
- **Issue:** Plan 01 had not committed yet, and passwordResets requires FK to users table
- **Fix:** Added users and refreshTokens tables alongside passwordResets
- **Files modified:** apps/api/src/db/schema.ts
- **Verification:** TypeScript compiles, FK references resolve
- **Committed in:** efaa3bc (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added JWT config getters**
- **Found during:** Task 1
- **Issue:** JWT config needed for auth system, Plan 01 not yet committed
- **Fix:** Added JWT config getters (later overwritten by Plan 01 with split access/refresh secrets)
- **Files modified:** apps/api/src/config/config.service.ts
- **Verification:** TypeScript compiles
- **Committed in:** efaa3bc (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 missing critical for parallel execution)
**Impact on plan:** Necessary for FK resolution. Plan 01 later refined the schema with additional fields.

## Issues Encountered
- TypeScript compilation shows errors in `user-auth.service.ts` from Plan 01's concurrent work (JWT sign overload mismatch) -- out of scope for this plan, logged but not fixed.
- vi.mock hoisting issue in tests required using vi.hoisted() for mock variable declarations -- standard Vitest pattern.

## User Setup Required
None - no external service configuration required. SMTP is optional (console fallback in dev).

## Next Phase Readiness
- MailService ready for injection into user-auth service (Plan 01/03)
- passwordResets table ready for forgot-password/reset-password flow
- Plan 03 (frontend auth) can wire reset password UI to these endpoints

---
*Phase: 16-user-authentication*
*Completed: 2026-03-08*
