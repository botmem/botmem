# WhatsApp Connector Fix — Design

## Problem
WhatsApp connector doesn't work. Baileys warm session fails silently, QR code never generates, `initiateAuth` times out after 90s. No readiness indicator in UI.

## Root Causes (Suspected)
1. CJS/ESM interop for Baileys may be wrong — `makeWASocket` could be `undefined`
2. Silent logger hides all Baileys errors — impossible to diagnose
3. Stale session directories could cause Baileys to attempt login instead of pairing (skips QR)
4. No readiness feedback — user sees nothing while Baileys warms up

## Tasks

### Task 1: Diagnose and fix Baileys connection
**Files:** `packages/connectors/whatsapp/src/qr-auth.ts`, `packages/connectors/whatsapp/src/index.ts`

1. Fix CJS/ESM interop — check actual Baileys v6.17.16 exports and use correct import pattern
2. Replace `silentLogger` with a real pino logger at `warn` level (or use Baileys' built-in logger) so errors are visible
3. Ensure fresh session directory on each warm-up (no stale `creds.json`)
4. Add error logging in the `onError` and `.catch()` handlers in `WhatsAppConnector._warm()`
5. Test that `startQrAuth` actually generates a QR code

**Acceptance criteria:**
- `POST /api/auth/whatsapp/initiate` returns a QR data URL within 30s
- Baileys errors are logged to console (not swallowed)
- Build passes (`pnpm --filter @botmem/connector-whatsapp build`)

### Task 2: Add connector readiness status
**Files:** `packages/connectors/whatsapp/src/index.ts`, `apps/api/src/connectors/connectors.controller.ts`, `packages/connector-sdk/src/base.ts`

1. Add `getStatus()` method to `WhatsAppConnector` returning `{ ready: boolean; status: 'warming' | 'qr_ready' | 'error'; message?: string }`
2. Add `GET /api/connectors/:type/status` endpoint that calls `connector.getStatus?.()` (optional method on BaseConnector)
3. WhatsApp connector tracks its warm session state and exposes it

**Acceptance criteria:**
- `GET /api/connectors/whatsapp/status` returns `{ ready: true, status: 'qr_ready' }` when warm session has QR
- Returns `{ ready: false, status: 'warming' }` when initializing
- Returns `{ ready: false, status: 'error', message: '...' }` on failure

### Task 3: Frontend readiness indicator + QR modal improvements
**Files:** `apps/web/src/components/connectors/ConnectorSetupModal.tsx`, `apps/web/src/lib/api.ts`, connector card components

1. Add `api.getConnectorStatus(type)` to the API client
2. In the WhatsApp card on the Connectors page, show a small status badge:
   - Green dot: "Ready"
   - Yellow dot + pulse: "Starting..."
   - Red dot: "Offline"
3. Poll `GET /api/connectors/whatsapp/status` every 5s while status !== 'qr_ready'
4. In QR modal: show "Connecting to WhatsApp..." while waiting, then QR when ready
5. Better error messages + retry button

**Acceptance criteria:**
- WhatsApp card shows readiness status
- QR modal shows meaningful progress
- After QR scan, modal closes and account appears

### Task 4: Fix sync.ts CJS/ESM interop
**Files:** `packages/connectors/whatsapp/src/sync.ts`

1. Apply same CJS/ESM fix as Task 1 to the sync module's Baileys import
2. Add the warn-level logger (not silent)

**Acceptance criteria:**
- Sync module uses correct Baileys import
- Build passes

### Task 5: End-to-end verification with agent-browser
1. Open http://localhost:5173/connectors
2. Verify WhatsApp readiness indicator shows
3. Click "+ ADD ACCOUNT" on WhatsApp
4. Verify QR code appears in modal
5. Take screenshot

**Acceptance criteria:**
- QR code visible in screenshot
- Readiness indicator visible on connectors page
