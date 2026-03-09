---
phase: quick-8
plan: '01'
subsystem: web-ui
tags: [ui-fix, accessibility, design-system, neobrutalist]
dependency_graph:
  requires: []
  provides: [UI-FIX-01]
  affects: [web-ui]
tech_stack:
  added: []
  patterns: [inline-svg-icons, nb-color-tokens, aria-labels]
key_files:
  modified:
    - apps/web/src/lib/connectorMeta.ts
    - apps/web/src/pages/ConnectorsPage.tsx
    - apps/web/src/pages/DashboardPage.tsx
    - apps/web/src/pages/MemoryExplorerPage.tsx
    - apps/web/src/pages/ForgotPasswordPage.tsx
    - apps/web/src/pages/ResetPasswordPage.tsx
    - apps/web/src/pages/OnboardingPage.tsx
    - apps/web/src/pages/ContactsPage.tsx
    - apps/web/src/pages/SettingsPage.tsx
    - apps/web/src/components/layout/Topbar.tsx
    - apps/web/src/components/layout/Sidebar.tsx
    - apps/web/src/components/memory/SearchResultsBanner.tsx
    - apps/web/src/components/connectors/ConnectorSetupModal.tsx
    - apps/web/src/components/connectors/QrCodeAuth.tsx
    - apps/web/src/components/ui/ReauthModal.tsx
    - apps/web/src/pages/LandingPage.tsx
decisions:
  - 'Out-of-scope pre-existing emoji in MemoryCard and PipelineLogFeed deferred (not in plan files)'
  - 'ConnectorAccountRow text-yellow-400 pre-existing off-brand color deferred to deferred-items'
metrics:
  duration: 15min
  completed_date: '2026-03-09'
  tasks: 3
  files: 16
---

# Quick Task 8: Fix All UI/UX Issues from Visual E2E Review — Summary

**One-liner:** Neobrutalist design system enforcement — replaced emoji with SVG/ASCII icons, migrated all off-brand Tailwind colors to nb-\* tokens, added Logo+ThemeToggle to auth pages, and fixed accessibility attributes across 16 files.

## Objectives

Fix 28 issues identified in the UI-REVIEW.md across 12 pages — Critical + High severity first, then Medium polish items. Bring the app to a shippable visual standard.

## Tasks Completed

### Task 1: Fix emoji icons and critical colors (commit e59a96d)

**connectorMeta.ts**

- Replaced Unicode emoji icons (Gmail ✉, WhatsApp 💬, Photos 📷, Locations 📍) with ASCII abbreviations: `G`, `W`, `Ph`, `Lo`
- Fallback changed from lightning emoji ⚡ to `?`
- Added `photos-immich` key mapping

**ConnectorsPage.tsx**

- `ConnectorStatusDot`: `bg-green-400` → `bg-nb-green`, `bg-yellow-400` → `bg-nb-yellow`, `bg-red-400` → `bg-nb-red`
- Heading upgraded from `text-xl` to `text-3xl`
- Accordion toggle button: added `aria-expanded={isExpanded}` and `aria-label`
- EmptyState icon changed from `⚡` emoji to `+`

**DashboardPage.tsx**

- Lock emoji `&#x1F512;` replaced with inline SVG lock icon (40x40)
- Unlock button: added `aria-label="Unlock encryption key"`

**MemoryExplorerPage.tsx**

- Lock emoji replaced with inline SVG lock icon (48x48)
- "Retry Failed" and "Re-enrich All" buttons: removed `rounded-lg`, changed `border` to `border-3` (neobrutalist)
- Backfill message container: removed `rounded-md`
- EmptyState icon changed from `*` to `0`

### Task 2: Auth pages Logo/ThemeToggle + high-severity UX fixes (commit b8acb2c)

**ForgotPasswordPage.tsx**

- Added mobile top bar (`md:hidden`) with Logo + ThemeToggle
- Added Logo + ThemeToggle to right decorative panel
- Heading capitalized to `FORGOT PASSWORD`

**ResetPasswordPage.tsx**

- Same mobile top bar and right panel Logo + ThemeToggle
- Invalid-link (`!token`) branch: refactored from single centered box to full dual-panel layout matching other auth pages
- Headings capitalized: `INVALID LINK` and `RESET PASSWORD`

**OnboardingPage.tsx**

- Added Logo + ThemeToggle in a flex header row above the setup heading

**ContactsPage.tsx**

- Search input: added `<label htmlFor="contacts-search" className="sr-only">` + `aria-label="Search people"` + `id="contacts-search"`
- `MergeTinder` wrapped in `{filteredSuggestions.length > 0 && ...}` to avoid dead DOM when empty

**SettingsPage.tsx**

- Profile tab description updated to explain disabled fields: "Name and email are managed through your auth provider and cannot be changed here."

**Topbar.tsx**

- Imported `useAuth` hook
- Added user initials badge (8x8 box) showing first letter of name or email with `aria-label`

**Sidebar.tsx**

- Collapse/expand button: added `aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}`
- Logout button: added `aria-label="Logout"`

### Task 3: Off-brand colors and Landing page icons (commit 5fc1674)

**SearchResultsBanner.tsx**

- All 8 banner variants replaced: `border-yellow-500/40` → `border-nb-yellow/40`, `bg-yellow-500/10` → `bg-nb-yellow/10`, `text-yellow-300` → `text-nb-yellow`, `text-yellow-100` → `text-nb-text`, `border-cyan-500/40` → `border-nb-blue/40`, `bg-cyan-500/10` → `bg-nb-blue/10`, `text-cyan-300` → `text-nb-blue`, `text-cyan-100` → `text-nb-text`
- Covers both main component and `ResolvedEntitiesBanner` sub-component

**ConnectorSetupModal.tsx**

- Error block: `border-red-500 bg-red-500/10 text-red-400` → `border-nb-red bg-nb-red/10 text-nb-red`

**QrCodeAuth.tsx**

- Failed state: `border-red-500` → `border-nb-red`, `text-red-500` → `text-nb-red`, `text-red-400` → `text-nb-red`
- Removed `rounded-full` from icon wrapper div

**ReauthModal.tsx**

- Error paragraph: `text-red-400` → `text-nb-red`

**LandingPage.tsx**

- FEATURES array type changed from `string` to `ReactNode` (added `import type { ReactNode }`)
- All 6 Unicode feature icons replaced with inline SVGs:
  1. 6 CONNECTORS: two linked circles (plug/link)
  2. FULLY LOCAL: database/cylinder (ellipse + paths)
  3. CONTACT GRAPH: two-person silhouette
  4. FACTUALITY: star/badge icon
  5. MEMORY GRAPH: three connected nodes
  6. AGENT API: code/terminal icon (`</>` polylines)
- FeaturesSection renders `{f.icon}` directly (ReactNode, not string)

## Deviations from Plan

None — plan executed exactly as written.

## Deferred Items

The following pre-existing issues were found in out-of-scope files and logged here (not fixed):

1. `apps/web/src/components/memory/MemoryCard.tsx` — Unicode emoji source icons (`\u2709`, `\uD83D\uDCAC`, `\uD83D\uDCF7`, `\uD83D\uDCCD`)
2. `apps/web/src/components/connectors/ConnectorAccountRow.tsx:95` — `text-yellow-400` in status class
3. `apps/web/src/components/dashboard/PipelineLogFeed.tsx:18` — Unicode `◈` glyph for embed stage icon

## Self-Check

### Files exist:

- /Users/amr/Projects/botmem/apps/web/src/lib/connectorMeta.ts — FOUND
- /Users/amr/Projects/botmem/apps/web/src/pages/ForgotPasswordPage.tsx — FOUND
- /Users/amr/Projects/botmem/apps/web/src/pages/ResetPasswordPage.tsx — FOUND
- /Users/amr/Projects/botmem/apps/web/src/pages/OnboardingPage.tsx — FOUND
- /Users/amr/Projects/botmem/apps/web/src/components/memory/SearchResultsBanner.tsx — FOUND

### Commits exist:

- e59a96d (Task 1) — FOUND
- b8acb2c (Task 2) — FOUND
- 5fc1674 (Task 3) — FOUND

### TypeScript: clean (npx tsc --noEmit returned no errors)

## Self-Check: PASSED
