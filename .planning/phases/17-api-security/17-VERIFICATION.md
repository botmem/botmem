---
phase: 17-api-security
verified: 2026-03-08T15:00:00Z
status: passed
score: 4/4 must-haves verified
re_verification: false
---

# Phase 17: API Security Verification Report

**Phase Goal:** All API endpoints require authentication except explicitly public ones, and CORS is locked to the frontend origin
**Verified:** 2026-03-08T15:00:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Unauthenticated requests to protected endpoints return 401 | VERIFIED | `APP_GUARD` registered with `JwtAuthGuard` in `app.module.ts` (line 59-61). Guard delegates to passport for non-public routes, which rejects without valid JWT. |
| 2 | Public endpoints return 200 without auth | VERIFIED | `@Public()` decorator confirmed on: `health.controller.ts` (class-level), `version.controller.ts` (class-level), `auth.controller.ts` (class-level), `user-auth.controller.ts` (per-method on register, login, refresh, logout, forgot-password, reset-password). Guard checks `IS_PUBLIC_KEY` metadata and returns `true` to bypass auth. |
| 3 | WebSocket connections without valid JWT are rejected with close code 4401 | VERIFIED | `events.gateway.ts` handleConnection extracts `token` from query params, calls `jwtService.verify(token, { secret: config.jwtAccessSecret })`, closes with 4401 on missing/invalid token. JwtModule registered in `events.module.ts` with async config. |
| 4 | CORS only allows requests from FRONTEND_URL origin with credentials enabled | VERIFIED | `main.ts` (lines 47-54) calls `app.enableCors()` with `origin: config.frontendUrl` (supports comma-separated), `credentials: true`, explicit methods and allowedHeaders. No wildcard. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/app.module.ts` | APP_GUARD registration of JwtAuthGuard | VERIFIED | Line 59: `{ provide: APP_GUARD, useClass: JwtAuthGuard }` |
| `apps/api/src/health.controller.ts` | Health check endpoint with @Public() | VERIFIED | 11 lines, returns `{ status: 'ok' }`, @Public() at class level |
| `apps/api/src/version.controller.ts` | Version endpoint marked public | VERIFIED | @Public() at class level (line 13) |
| `apps/api/src/auth/auth.controller.ts` | OAuth controller marked public | VERIFIED | @Public() at class level (line 7) |
| `apps/api/src/events/events.gateway.ts` | WebSocket JWT verification in handleConnection | VERIFIED | `jwtService.verify(token, { secret: this.config.jwtAccessSecret })` at line 49 |
| `apps/api/src/main.ts` | CORS locked to FRONTEND_URL with credentials | VERIFIED | `credentials: true` at line 51, origin from `config.frontendUrl` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `app.module.ts` | `user-auth/jwt-auth.guard.ts` | APP_GUARD provider | WIRED | Import at line 24, provider at line 59-61 |
| `events/events.gateway.ts` | `@nestjs/jwt` | JwtService.verify in handleConnection | WIRED | JwtService injected via constructor (line 24), verify called at line 49 |
| `main.ts` | `config/config.service.ts` | frontendUrl for CORS origin | WIRED | `config.frontendUrl` used at line 48 for origin |
| `web/store/jobStore.ts` | `web/lib/ws.ts` | Token passed to subscribe | WIRED | `useAuthStore.getState().accessToken` passed to `sharedWs.subscribe()` |
| `web/store/memoryStore.ts` | `web/lib/ws.ts` | Token passed to subscribe | WIRED | `useAuthStore.getState().accessToken` passed to `sharedWs.subscribe()` |
| `web/lib/ws.ts` | WebSocket URL | Token in query param | WIRED | `?token=${encodeURIComponent(this.token)}` in connect URL; guards against pre-auth connect |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SEC-01 | 17-01 | Auth guard on all endpoints (except /health, /version, /auth/*) | SATISFIED | APP_GUARD globally registered; @Public() on health, version, auth, user-auth public endpoints |
| SEC-02 | 17-01 | CORS locked to FRONTEND_URL origin(s), credentials mode enabled | SATISFIED | `main.ts` CORS config uses `config.frontendUrl` with `credentials: true`, no wildcard |

No orphaned requirements found -- REQUIREMENTS.md maps SEC-01 and SEC-02 to Phase 17, both claimed by plan 17-01.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No anti-patterns detected |

No TODOs, FIXMEs, placeholders, empty implementations, or stub handlers found in any key files.

### Human Verification Required

### 1. Protected endpoint returns 401

**Test:** `curl http://localhost:12412/api/accounts` without Authorization header
**Expected:** HTTP 401 Unauthorized response
**Why human:** Requires running server to confirm guard activates end-to-end

### 2. Public endpoint returns 200

**Test:** `curl http://localhost:12412/api/version` and `curl http://localhost:12412/api/health`
**Expected:** HTTP 200 with version info and `{ "status": "ok" }` respectively
**Why human:** Requires running server

### 3. CORS rejects unknown origin

**Test:** `curl -H "Origin: http://evil.com" -X OPTIONS http://localhost:12412/api/memories`
**Expected:** No `Access-Control-Allow-Origin` header in response
**Why human:** Requires running server to confirm NestJS CORS middleware behavior

### 4. WebSocket rejected without token

**Test:** Open browser DevTools, run `new WebSocket('ws://localhost:12412/events')` and observe close event
**Expected:** Connection closed with code 4401
**Why human:** Requires running server and WebSocket client

### Gaps Summary

No gaps found. All four must-have truths are verified at all three levels (exists, substantive, wired). Both requirements (SEC-01, SEC-02) are satisfied. Commits `0924db7` and `292425b` exist in git history. Test coverage includes unit tests for the guard, CORS configuration tests, and WebSocket auth tests.

---

_Verified: 2026-03-08T15:00:00Z_
_Verifier: Claude (gsd-verifier)_
