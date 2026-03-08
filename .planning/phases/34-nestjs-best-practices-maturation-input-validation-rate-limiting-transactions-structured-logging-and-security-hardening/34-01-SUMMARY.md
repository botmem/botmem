---
phase: 34-nestjs-best-practices-maturation
plan: 01
subsystem: api
tags: [class-validator, class-transformer, nestjs-throttler, dto, validation, rate-limiting]

# Dependency graph
requires:
  - phase: 16-user-authentication
    provides: JWT auth guards and user-auth controller endpoints
provides:
  - Global ValidationPipe rejecting invalid input with 400 status
  - 18 DTO classes with class-validator decorators across all API modules
  - ThrottlerModule with 100/min default rate limit
  - Per-route rate limits on auth (3-5/min) and AI (20/min) endpoints
  - WebSocket gateway exempt from throttling
affects: [34-02, 34-03, api-security, agent-endpoints]

# Tech tracking
tech-stack:
  added: [class-validator, class-transformer, '@nestjs/throttler']
  patterns:
    [
      DTO validation pattern,
      global ValidationPipe,
      ThrottlerGuard as APP_GUARD,
      per-route @Throttle overrides,
    ]

key-files:
  created:
    - apps/api/src/user-auth/dto/register.dto.ts
    - apps/api/src/user-auth/dto/login.dto.ts
    - apps/api/src/user-auth/dto/forgot-password.dto.ts
    - apps/api/src/user-auth/dto/reset-password.dto.ts
    - apps/api/src/accounts/dto/create-account.dto.ts
    - apps/api/src/accounts/dto/update-account.dto.ts
    - apps/api/src/contacts/dto/update-contact.dto.ts
    - apps/api/src/contacts/dto/split-contact.dto.ts
    - apps/api/src/contacts/dto/merge-contact.dto.ts
    - apps/api/src/contacts/dto/search-contacts.dto.ts
    - apps/api/src/contacts/dto/dismiss-suggestion.dto.ts
    - apps/api/src/agent/dto/ask.dto.ts
    - apps/api/src/agent/dto/remember.dto.ts
    - apps/api/src/agent/dto/summarize.dto.ts
    - apps/api/src/memory/dto/search-memories.dto.ts
    - apps/api/src/memory-banks/dto/create-memory-bank.dto.ts
    - apps/api/src/memory-banks/dto/rename-memory-bank.dto.ts
    - apps/api/src/api-keys/dto/create-api-key.dto.ts
  modified:
    - apps/api/src/main.ts
    - apps/api/src/app.module.ts
    - apps/api/src/user-auth/user-auth.controller.ts
    - apps/api/src/accounts/accounts.controller.ts
    - apps/api/src/contacts/contacts.controller.ts
    - apps/api/src/agent/agent.controller.ts
    - apps/api/src/memory/memory.controller.ts
    - apps/api/src/memory-banks/memory-banks.controller.ts
    - apps/api/src/api-keys/api-keys.controller.ts
    - apps/api/src/events/events.gateway.ts

key-decisions:
  - 'ValidationPipe uses whitelist+transform (strip unknown props, auto-convert types) without forbidNonWhitelisted to avoid breaking existing clients'
  - 'Single default throttle tier (100/min) with per-route overrides for auth and AI endpoints'
  - 'UpdateAccountDto uses SyncSchedule type from @botmem/shared for type-safe schedule validation'

patterns-established:
  - 'DTO per endpoint: one DTO class per file in module/dto/ directory'
  - 'Definite assignment (!) on required DTO properties to satisfy strict TypeScript'
  - 'Email fields auto-lowercase+trim via @Transform decorator'

requirements-completed: [BP-01, BP-02]

# Metrics
duration: 6min
completed: 2026-03-08
---

# Phase 34 Plan 01: Input Validation & Rate Limiting Summary

**Global ValidationPipe with 18 DTO classes across all modules, ThrottlerGuard with auth (3-5/min) and AI (20/min) rate limits**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-08T19:25:11Z
- **Completed:** 2026-03-08T19:31:30Z
- **Tasks:** 2
- **Files modified:** 29

## Accomplishments

- All controller @Body() parameters now use validated DTO classes with class-validator decorators
- Global ValidationPipe rejects invalid input with 400 status and descriptive error messages
- ThrottlerGuard applies default 100/min rate limit globally with strict per-route overrides on auth and AI endpoints
- WebSocket gateway exempt from throttling via @SkipThrottle()

## Task Commits

Each task was committed atomically:

1. **Task 1: Install dependencies and create all DTO classes** - `89a4164` (feat)
2. **Task 2: Enable global ValidationPipe, ThrottlerModule, and wire DTOs into controllers** - `4d4857e` (feat)

## Files Created/Modified

- `apps/api/src/user-auth/dto/*.dto.ts` - Register, Login, ForgotPassword, ResetPassword DTOs
- `apps/api/src/accounts/dto/*.dto.ts` - CreateAccount, UpdateAccount DTOs
- `apps/api/src/contacts/dto/*.dto.ts` - UpdateContact, SplitContact, MergeContact, SearchContacts, DismissSuggestion DTOs
- `apps/api/src/agent/dto/*.dto.ts` - Ask (with nested AskFiltersDto), Remember, Summarize DTOs
- `apps/api/src/memory/dto/search-memories.dto.ts` - SearchMemories DTO
- `apps/api/src/memory-banks/dto/*.dto.ts` - CreateMemoryBank, RenameMemoryBank DTOs
- `apps/api/src/api-keys/dto/create-api-key.dto.ts` - CreateApiKey DTO
- `apps/api/src/main.ts` - Added global ValidationPipe
- `apps/api/src/app.module.ts` - Added ThrottlerModule and ThrottlerGuard
- `apps/api/src/events/events.gateway.ts` - Added @SkipThrottle()
- All 7 controllers updated to use DTO types

## Decisions Made

- ValidationPipe uses `whitelist: true` (strip unknown) without `forbidNonWhitelisted` to avoid breaking existing clients that may send extra fields
- Single default throttle tier (100/min) -- simpler than multi-tier, adequate for this app's scale
- UpdateAccountDto imports SyncSchedule type from @botmem/shared for compile-time type safety

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added definite assignment assertions to DTO properties**

- **Found during:** Task 1 (DTO creation)
- **Issue:** TypeScript strict mode requires initializers or definite assignment for class properties; DTOs are populated by class-transformer, not constructors
- **Fix:** Added `!` (definite assignment assertion) to all required DTO properties
- **Files modified:** All 18 DTO files
- **Committed in:** 89a4164

**2. [Rule 1 - Bug] Fixed UpdateAccountDto schedule type mismatch**

- **Found during:** Task 2 (wiring DTOs into controllers)
- **Issue:** Plan specified `schedule?: string` but AccountsService.update expects `SyncSchedule` type; also plan listed 'weekly' but SyncSchedule type uses '15min'
- **Fix:** Changed to `schedule?: SyncSchedule` with @IsIn matching the actual SyncSchedule union values
- **Files modified:** apps/api/src/accounts/dto/update-account.dto.ts
- **Committed in:** 4d4857e

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for TypeScript compilation. No scope creep.

## Issues Encountered

- Pre-existing test failures in accounts.service, auth.service, and jobs.controller tests (17 tests) -- unrelated to validation/throttler changes, caused by incomplete mocking of DbService

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Validation and rate limiting foundation complete
- Plan 02 (structured logging) can proceed independently
- Plan 03 (error handling) can proceed independently

---

_Phase: 34-nestjs-best-practices-maturation_
_Completed: 2026-03-08_
