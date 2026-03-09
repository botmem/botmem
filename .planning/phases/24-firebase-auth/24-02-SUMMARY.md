---
phase: 24-firebase-auth
plan: 02
subsystem: auth
tags: [firebase, react, zustand, google-auth, github-auth, social-login, tailwind]

# Dependency graph
requires:
  - phase: 24-firebase-auth-01
    provides: Firebase Admin SDK backend (FirebaseAuthGuard, /api/firebase-auth/sync endpoint)
provides:
  - Firebase client SDK initialization (apps/web/src/lib/firebase.ts)
  - loginWithFirebase action in authStore for Google/GitHub popup auth
  - isFirebaseMode exported constant for conditional UI rendering
  - LoginForm and SignupForm with conditional social login buttons
affects: [35-fixture-capture, ui-auth, frontend-auth]

# Tech tracking
tech-stack:
  added: [firebase@^11.0.0 (client SDK)]
  patterns:
    - isFirebaseMode constant (VITE_AUTH_PROVIDER env check) gates all Firebase UI conditionally
    - Firebase ID token stored as accessToken in authStore for Bearer auth on all API calls
    - onAuthStateChanged used in initialize() for firebase mode session restoration
    - SVG icon buttons for social login (no emoji, official brand marks)

key-files:
  created:
    - apps/web/src/lib/firebase.ts
  modified:
    - apps/web/src/store/authStore.ts
    - apps/web/src/components/auth/LoginForm.tsx
    - apps/web/src/components/auth/SignupForm.tsx
    - apps/web/package.json

key-decisions:
  - 'Firebase ID token stored as accessToken in authStore — reuses existing Bearer token infrastructure for API calls'
  - 'isFirebaseMode = VITE_AUTH_PROVIDER === firebase — evaluated at module load, zero runtime cost'
  - 'initialize() branches on isFirebaseMode: onAuthStateChanged (firebase) vs refreshSession (local) — clean separation'
  - 'popup-closed-by-user / cancelled-popup-request codes handled gracefully — no error state shown'
  - 'Social buttons use official SVG brand marks (Google colored G, GitHub Invertocat) — no emoji'

patterns-established:
  - 'isFirebaseMode guard: wrap any Firebase-specific UI in {isFirebaseMode && (...)} for clean local/firebase split'
  - 'Firebase auth flow: signInWithPopup -> getIdToken -> POST /api/firebase-auth/sync -> set store user+accessToken'

requirements-completed: [FBAUTH-02, FBAUTH-04]

# Metrics
duration: 8min
completed: 2026-03-09
---

# Phase 24 Plan 02: Firebase Auth Frontend Summary

**Firebase client SDK with Google/GitHub social login buttons in LoginForm/SignupForm, gated by VITE_AUTH_PROVIDER=firebase, using signInWithPopup and backend sync via /api/firebase-auth/sync**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-09T12:00:00Z
- **Completed:** 2026-03-09T12:08:00Z
- **Tasks:** 2 (+ checkpoint auto-approved)
- **Files modified:** 5

## Accomplishments

- Firebase client SDK (^11.0.0) installed in apps/web; firebase.ts exports firebaseAuth, googleProvider, githubProvider
- authStore extended with loginWithFirebase(provider) action, isFirebaseMode constant, and Firebase-aware initialize()/logout()
- LoginForm and SignupForm conditionally show Google + GitHub buttons (with SVG icons) only when VITE_AUTH_PROVIDER=firebase
- Popup-dismissed-by-user handled gracefully with no error state
- Typecheck passes with zero errors

## Task Commits

1. **Task 1: Firebase client SDK + authStore firebase actions** - `9dc81ea` (feat)
2. **Task 2: Firebase social login buttons in LoginForm and SignupForm** - `019a5c2` (feat)

## Files Created/Modified

- `apps/web/src/lib/firebase.ts` - Firebase app initialization with HMR guard; exports firebaseAuth, googleProvider, githubProvider
- `apps/web/src/store/authStore.ts` - Added loginWithFirebase action, isFirebaseMode constant, Firebase-aware initialize/logout
- `apps/web/src/components/auth/LoginForm.tsx` - Added Google/GitHub SVG buttons below divider, only when isFirebaseMode
- `apps/web/src/components/auth/SignupForm.tsx` - Same social button pattern as LoginForm
- `apps/web/package.json` - Added firebase ^11.0.0 to dependencies

## Decisions Made

- Firebase ID token stored as accessToken in authStore — reuses existing Bearer token infrastructure without changes to API fetch layer
- isFirebaseMode evaluated at module import time (const, not function) — zero runtime cost, tree-shakeable
- onAuthStateChanged in initialize() ensures fresh token on every page load for Firebase mode; local mode unchanged (refreshSession)
- auth/popup-closed-by-user and auth/cancelled-popup-request treated as non-errors — sets isLoading false, no error message
- Official SVG brand marks used for Google (colored G) and GitHub (Invertocat) — accessibility-friendly with aria-hidden

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

To test Firebase social login:

1. Start web dev server with: `VITE_AUTH_PROVIDER=firebase pnpm --filter @botmem/web dev:standalone`
2. Ensure API is running with `AUTH_PROVIDER=firebase` and `FIREBASE_PROJECT_ID=botmem-app`
3. Google and GitHub providers must be enabled in Firebase Console (botmem-app project)
4. Visit http://localhost:12412/login — Google and GitHub buttons appear below email/password form

## Next Phase Readiness

- Phase 24 (Firebase Auth) is now fully complete — both backend (24-01) and frontend (24-02) are done
- v4.0 phases 35-39 (E2E Testing) are now unblocked; the auth architecture is finalized
- Local mode (VITE_AUTH_PROVIDER unset) is completely unchanged — existing users unaffected

---

_Phase: 24-firebase-auth_
_Completed: 2026-03-09_
