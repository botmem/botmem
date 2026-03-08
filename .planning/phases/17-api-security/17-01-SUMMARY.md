---
phase: 17-api-security
plan: 01
subsystem: auth
tags: [jwt, cors, websocket, nestjs, passport, guard]

requires:
  - phase: 16-user-authentication
    provides: JwtAuthGuard, @Public decorator, JwtStrategy, UserAuthModule

provides:
  - Global JWT auth guard (APP_GUARD) protecting all endpoints by default
  - @Public() decorators on version, health, and OAuth controllers
  - CORS locked to FRONTEND_URL with credentials
  - WebSocket JWT authentication in EventsGateway
  - Health check endpoint (/api/health)

affects: [18-data-encryption, frontend-auth-flow]

tech-stack:
  added: []
  patterns: [APP_GUARD global auth, @Public() opt-out pattern, WS token query param]

key-files:
  created:
    - apps/api/src/health.controller.ts
    - apps/api/src/user-auth/__tests__/global-guard.test.ts
    - apps/api/src/__tests__/cors.test.ts
    - apps/api/src/events/__tests__/ws-auth.test.ts
  modified:
    - apps/api/src/app.module.ts
    - apps/api/src/main.ts
    - apps/api/src/version.controller.ts
    - apps/api/src/auth/auth.controller.ts
    - apps/api/src/events/events.gateway.ts
    - apps/api/src/events/events.module.ts
    - apps/web/src/lib/ws.ts
    - apps/web/src/store/jobStore.ts
    - apps/web/src/store/memoryStore.ts

key-decisions:
  - "CORS supports comma-separated FRONTEND_URL for multi-origin deployments"
  - "WebSocket auth via token query param (not header) for browser WebSocket API compatibility"
  - "WsClient refuses to connect without token -- prevents pre-auth connection attempts"

patterns-established:
  - "APP_GUARD with @Public() opt-out: all new endpoints are protected by default"
  - "WS auth pattern: token in query string, verified in handleConnection"

requirements-completed: [SEC-01, SEC-02]

duration: 5min
completed: 2026-03-08
---

# Phase 17 Plan 01: API Security Lockdown Summary

**Global JWT guard on all endpoints with @Public() opt-out, CORS locked to frontend origin, WebSocket JWT handshake verification**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-08T14:25:04Z
- **Completed:** 2026-03-08T14:30:14Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- All API endpoints now require JWT authentication by default via APP_GUARD
- Public endpoints (@Public) explicitly opted out: /api/version, /api/health, /api/auth/*, /api/user-auth/(login|register|refresh|logout|forgot-password|reset-password)
- CORS restricted to FRONTEND_URL with credentials enabled (no more wildcard)
- WebSocket connections require valid JWT token in query parameter (rejected with close code 4401)
- Frontend WsClient passes auth token from authStore on connect/subscribe
- Health check endpoint created at /api/health returning { status: 'ok' }

## Task Commits

Each task was committed atomically:

1. **Task 1: Global auth guard, @Public decorators, CORS config, health endpoint** - `0924db7` (feat)
2. **Task 2: WebSocket JWT authentication and frontend token passing** - `292425b` (feat)

## Files Created/Modified
- `apps/api/src/health.controller.ts` - Health check endpoint with @Public()
- `apps/api/src/app.module.ts` - APP_GUARD registration of JwtAuthGuard + HealthController
- `apps/api/src/main.ts` - CORS locked to FRONTEND_URL with credentials
- `apps/api/src/version.controller.ts` - Added @Public() decorator
- `apps/api/src/auth/auth.controller.ts` - Added @Public() decorator
- `apps/api/src/events/events.gateway.ts` - JWT verification in handleConnection
- `apps/api/src/events/events.module.ts` - JwtModule import for token verification
- `apps/web/src/lib/ws.ts` - Token-based WS connection with pre-auth guard
- `apps/web/src/store/jobStore.ts` - Pass access token to WS subscribe
- `apps/web/src/store/memoryStore.ts` - Pass access token to WS subscribe
- `apps/api/src/user-auth/__tests__/global-guard.test.ts` - Guard unit tests
- `apps/api/src/__tests__/cors.test.ts` - CORS config tests
- `apps/api/src/events/__tests__/ws-auth.test.ts` - WS auth tests

## Decisions Made
- CORS supports comma-separated FRONTEND_URL for multi-origin deployments (e.g., dev + staging)
- WebSocket auth uses token query parameter (not Authorization header) because browser WebSocket API does not support custom headers
- WsClient refuses to connect without a token, preventing pre-auth connection spam

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failure in user-auth.service.test.ts (MailService dependency missing in test module) -- not caused by this plan's changes, out of scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All endpoints protected by default -- any new controllers/endpoints are automatically secured
- WebSocket authentication enforced -- frontend passes token automatically
- Ready for Phase 18 (data encryption) or any additional security hardening

---
*Phase: 17-api-security*
*Completed: 2026-03-08*
