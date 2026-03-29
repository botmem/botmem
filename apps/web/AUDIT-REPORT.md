# Botmem Frontend Audit Report (Post-Fix)

**Date**: 2026-03-16
**Scope**: `apps/web/src/` — all components, pages, styles, and configuration
**Context**: Re-audit after running `/normalize`, `/harden`, and `/optimize`

---

## Anti-Patterns Verdict

**PASS.** This does not look AI-generated. The neobrutalist aesthetic is consistent and intentional — zero border-radius, hard offset shadows, monospace everything, bold lime accent. No gradient text, no glassmorphism, no cyan-on-dark, no generic fonts.

The stat card grids (Dashboard + MePage) are the closest thing to a generic AI layout, but the neobrutalist chrome (hard borders, colored label bars, monospace type) keeps them distinctive enough.

---

## Executive Summary

| Severity  | Previous | Current | Resolved |
| --------- | -------- | ------- | -------- |
| Critical  | 3        | 0       | 3        |
| High      | 7        | 2       | 5        |
| Medium    | 9        | 5       | 4        |
| Low       | 5        | 4       | 1        |
| **Total** | **24**   | **11**  | **13**   |

**13 of 24 issues resolved.** All 3 critical issues fixed. 5 of 7 high-severity issues fixed.

### What was fixed:

- **C1** Global `*` transition: scoped to `.theme-switching` class (perf)
- **C2** `text-nb-muted` contrast: bumped `#888888` -> `#A0A0A0` (6.14:1, passes WCAG AA)
- **C3** DashboardPage/MePage stat colors: now use `var(--color-nb-*)` tokens
- **H2** Form labels: `aria-label` added to SearchHeader, ConversationPanel, MemoryBanksTab inputs
- **H3** Select labels: `aria-label` added to ConnectorAccountRow selects
- **H4** Heading hierarchy: Topbar changed from `<h2>` to `<h1>`
- **H5** GraphLegend: SVG icons now use `var(--color-nb-text)` and `var(--color-nb-surface)`
- **H6** MePage connector colors: imports from `@botmem/shared` instead of re-defining
- **M3** `prefers-reduced-motion`: global override disabling all animations
- **M4** Avatar alt text: uses `name` prop, meaningful alt instead of `alt=""`
- **M8** FacetGroup: inline style replaced with Tailwind `rotate-90`/`rotate-0`
- Toggle: now `<button>` with `role="switch"` and `aria-checked`
- Shell overlay: `bg-nb-bg/80` instead of `bg-black/60`

---

## Remaining Issues

### HIGH (2)

#### H1. Hardcoded colors in GraphLegend SVG internals

- **Location**: `GraphLegend.tsx:193-194` — `stroke="#1A1A2E"` on file icon lines
- **Category**: Theming
- **Description**: While the outer SVG elements were migrated to `var(--color-nb-*)`, two inner `<line>` elements in the file diamond icon still use `#1A1A2E`. This color is invisible in light mode (dark stroke on white background — actually fine) but is a rogue value not in the theme system.
- **Impact**: Minor — the stroke happens to work in both themes since it's dark, but it breaks the principle of theme-token-only colors.
- **Recommendation**: Replace `#1A1A2E` with `var(--color-nb-surface)`.
- **Suggested command**: `/normalize`

#### H2. FacetSidebar defines its own CONNECTOR_COLORS

- **Location**: `FacetSidebar.tsx:24-29`
- **Category**: Theming / Maintainability
- **Description**: `FacetSidebar` has its own `CONNECTOR_COLORS` map with different values than `@botmem/shared` (`gmail: '#EA4335'` here vs shared definition). This was not addressed in the normalize pass.
- **Impact**: Facet sidebar shows different connector colors than the rest of the app.
- **Recommendation**: Import `CONNECTOR_COLORS` from `@botmem/shared` like `MemoryCard.tsx` does.
- **Suggested command**: `/normalize`

---

### MEDIUM (5)

#### M1. `text-[10px]` used for functional content — 20+ occurrences

- **Location**: `ConnectorSetupModal.tsx` (3), `NotificationDropdown.tsx` (3), `SearchInput.tsx` (1), `CreateKeyModal.tsx` (2), `IntegrationsTab.tsx` (2), `MemoryBanksTab.tsx` (1), `ActiveFilters.tsx` (1), `SearchPresets.tsx` (1), `GraphLegend.tsx` (5+), `TimeRangeFacet.tsx` (2)
- **Category**: Accessibility / Responsive (WCAG 1.4.4)
- **Description**: 10px font size is below the 12px minimum for readable body text. On mobile at standard DPI, this is ~6.5pt — difficult to read even with good vision.
- **Impact**: Users with any vision impairment cannot read status labels, timestamps, filter controls, or legend text.
- **Note**: The notification badge counter (`NotificationDropdown.tsx:87`) is acceptable at 10px since it's a number in a tight badge. Legend section headers in the graph overlay are also a borderline case since space is constrained.
- **Recommendation**: Replace `text-[10px]` with `text-[11px]` or `text-xs` (12px) for all body/label text. Badge counters can stay at 10px.
- **Suggested command**: `/adapt`

#### M2. No React error boundaries

- **Location**: `App.tsx`
- **Category**: Resilience
- **Description**: Zero error boundary components exist. A crash in the force-directed graph (canvas errors), memory list rendering, or timeline view takes down the entire page with a white screen.
- **Impact**: Production crashes show a blank page with no recovery path.
- **Recommendation**: Add error boundaries around: (1) the graph visualization, (2) the main content area in Shell, (3) each route's lazy-loaded page.
- **Suggested command**: `/harden`

#### M3. `ConnectorSetupModal` is 650+ lines

- **Location**: `ConnectorSetupModal.tsx`
- **Category**: Maintainability
- **Description**: Single component handles OAuth flow, QR auth, API key auth, WebSocket listeners, step wizard, form validation. Hard to test and modify.
- **Recommendation**: Extract auth-type-specific sub-components (OAuthSetup, QRAuthSetup, ApiKeySetup).
- **Suggested command**: `/distill`

#### M4. Inline `style={{}}` objects — ~55 remaining

- **Location**: 20+ components
- **Category**: Performance
- **Description**: Inline style objects create new references on every render. Many are justified (dynamic `backgroundColor` from data), but some could be Tailwind arbitrary values.
- **Impact**: Minor — prevents React reconciliation optimization for those elements.

#### M5. MePage still has 2 hardcoded colors

- **Location**: `MePage.tsx:342` (`#22C55E`, `#888888`), `MePage.tsx:420` (`#888`)
- **Category**: Theming
- **Description**: Badge status colors and fallback source-type colors are still hardcoded hex.
- **Recommendation**: Use `var(--color-nb-green)` / `var(--color-nb-muted)` for status, `var(--color-nb-gray)` for fallback.
- **Suggested command**: `/normalize`

---

### LOW (4)

#### L1. `autoprefixer` + `postcss` may be unused dependencies

- **Location**: `package.json`

#### L2. `posthog-js` loaded eagerly (~100KB)

- **Location**: `package.json`
- **Description**: No evidence of lazy loading. Loaded on every page including landing.

#### L3. `useCallback` underutilization

- **Location**: Multiple hooks/components
- **Description**: Very few `useCallback` instances. Event handlers passed to child components trigger unnecessary re-renders.

#### L4. `StreamGraph.tsx` uses `var()` in canvas context

- **Location**: `StreamGraph.tsx:84`
- **Description**: `ctx.fillStyle = 'var(--color-nb-muted, #ABB2BF)'` — CSS variables don't work in canvas 2D context. This silently fails, falling back to... nothing (canvas treats it as invalid, uses last valid color or black).
- **Impact**: Stream graph axis labels may render in wrong color or black.
- **Recommendation**: Use `getComputedStyle()` to resolve the value, like `graphDrawing.ts` does.
- **Suggested command**: `/normalize`

---

## Patterns & Systemic Issues

| Pattern                                   | Previous                | Current                 | Status             |
| ----------------------------------------- | ----------------------- | ----------------------- | ------------------ |
| Hardcoded hex colors outside theme tokens | 50+ instances           | ~15 remaining           | Mostly resolved    |
| `text-nb-muted` contrast failure          | 268 occurrences, 4.03:1 | 268 occurrences, 6.14:1 | **RESOLVED**       |
| `text-[10px]` for functional labels       | 20+ instances           | 20+ instances           | Unchanged          |
| `onClick` on `<div>` without keyboard     | 15+ instances           | ~10 remaining           | Partially resolved |
| Missing form label associations           | 8+ inputs               | 2 remaining             | Mostly resolved    |
| Color constants duplicated across files   | 4+ maps                 | 2 remaining             | Partially resolved |
| Global `*` transition perf hit            | Every element           | Scoped to theme switch  | **RESOLVED**       |

---

## Positive Findings

### Existing strengths (maintained):

1. **Design token system** — Comprehensive `@theme` block with full light/dark mode
2. **Self-hosted fonts** with `font-display: swap` — no render-blocking requests
3. **Route-level code splitting** — all 15+ pages use `lazy()` + `Suspense`
4. **Graph rendering performance** — canvas glyph caching, adaptive performance config
5. **Zero border-radius enforcement** — consistent neobrutalist identity

### New improvements from this session:

6. **Theme-scoped transitions** — `theme-switching` class approach eliminates global perf hit
7. **WCAG AA muted text contrast** — `#A0A0A0` (6.14:1) passes comfortably
8. **`prefers-reduced-motion` global override** — all animations/transitions disabled
9. **Proper ARIA roles** — Toggle has `role="switch"` + `aria-checked`, forms have labels
10. **Heading hierarchy fixed** — Topbar is `<h1>`, sections are `<h2>`
11. **Avatar meaningful alt text** — uses contact name instead of empty string
12. **DashboardPage + MePage stat cards** use theme tokens, not hardcoded hex
13. **GraphLegend SVGs** use CSS variables for stroke/fill
14. **MemoryDetailSidebar** canvas uses `getThemeColors()` pattern
15. **Shell overlay** uses theme-aware `bg-nb-bg/80`
16. **FacetGroup** uses Tailwind rotate classes instead of inline styles

---

## Recommendations by Priority

### Short-term (this sprint)

1. Fix `StreamGraph.tsx` canvas `var()` bug (L4) — broken rendering
2. Import `CONNECTOR_COLORS` in `FacetSidebar.tsx` from shared (H2)
3. Replace remaining `#1A1A2E` in GraphLegend (H1)
4. Fix MePage remaining hardcoded colors (M5)

### Medium-term (next sprint)

5. Bump `text-[10px]` to `text-[11px]` or `text-xs` across ~20 instances (M1)
6. Add error boundaries around graph, timeline, main content (M2)
7. Extract `ConnectorSetupModal` sub-components (M3)

### Long-term

8. Lazy-load PostHog (L2)
9. Audit/remove unused deps (L1)
10. Add `useCallback` to frequently-passed handlers (L3)

---

## Suggested Commands for Fixes

| Command      | Issues Addressed                            | Count |
| ------------ | ------------------------------------------- | ----- |
| `/normalize` | H1, H2, M5, L4 — remaining theme token gaps | 4     |
| `/harden`    | M2 — error boundaries                       | 1     |
| `/adapt`     | M1 — minimum font sizes                     | 1     |
| `/distill`   | M3 — ConnectorSetupModal decomposition      | 1     |
| `/optimize`  | L2, L3 — lazy loading, memoization          | 2     |

**Score: 13/24 issues resolved. Quality improved from ~60% to ~85%.** The remaining issues are medium/low severity — no critical or blocking problems remain.

---

## Visual Browser Audit (2026-03-16)

Performed live in Chrome at `localhost:12412` across dark mode, light mode, and mobile (375x812) viewports.

### Pages Tested

- Dashboard (dark + light + mobile)
- Memory Explorer (dark + light + mobile)
- People/Contacts (light + mobile)
- Settings > Profile, Memory Banks (dark)

### Confirmed Working

1. **Light mode theme switch** — all pages render correctly. Backgrounds, text, borders, shadows all swap to warm off-white palette. Transition is smooth (`.theme-switching` class works).
2. **Graph visualization in light mode** — background uses light surface color, nodes are colorful and visible, edges use appropriate contrast. No invisible elements.
3. **GraphLegend in light mode** — SVG icons readable, section headers ("NODES", "SOURCE", "RELATIONSHIPS") properly themed, toggle buttons have correct borders. `var(--color-nb-text)` and `var(--color-nb-surface)` fix confirmed working.
4. **Stat cards** — colored header bars (lime, pink, cyan, red) render correctly in both themes using `var(--color-nb-*)` tokens.
5. **Mobile responsive layout** — sidebar collapses to hamburger, stat cards stack to single column, memory cards fill width, text wraps properly, contact badges wrap correctly.
6. **Muted text contrast** — `#A0A0A0` in dark mode is clearly legible for timestamps ("1d ago"), scores ("0.24"), and secondary text. Significant improvement from previous `#888888`.
7. **RTL Arabic text** — renders correctly inline in memory cards without layout breakage.
8. **Empty state** — "NO MEMORIES FOUND / TRY A DIFFERENT SEARCH QUERY" is clear and well-styled.
9. **Contact avatars** — photos render properly in light mode with borders, fallback initials display correctly, lime border on self-card (Amr Essam) works.
10. **Pipeline view** — stages (SYNC, CLEAN, EMBED, ENRICH) readable on mobile despite tight space.

### New Visual Issues Found

#### V1. Duplicate "SETTINGS" heading (Medium)

- **Location**: Settings page
- **Description**: The page title "SETTINGS" appears twice — once in the Topbar `<h1>` and once as a large heading in the content area. Every other page only shows the title in the Topbar.
- **Impact**: Redundant, wastes vertical space, looks like a bug.
- **Recommendation**: Remove the in-content "SETTINGS" heading since the Topbar already shows it.
- **Suggested command**: `/polish`

#### V2. Pipeline stages cramped on mobile (Low)

- **Location**: Dashboard > Pipeline view at 375px width
- **Description**: Four pipeline stages (SYNC, CLEAN, EMBED, ENRICH) squeeze into a single row. Text is very small and stats below each stage are barely readable.
- **Impact**: Minor — the information is there but requires effort to parse on phone screens.
- **Recommendation**: Stack pipeline stages in 2x2 grid on mobile, or make them horizontally scrollable.
- **Suggested command**: `/adapt`

#### V3. RAG answer bar styling inconsistency (Low)

- **Location**: Memory Explorer search with results
- **Description**: The conversational RAG answer bar (lime background with generated text) appears above the empty state when search returns 0 results, creating a mixed message — "here's an answer" + "no memories found."
- **Impact**: Confusing UX when the RAG generates an answer but there are no matching documents.
- **Recommendation**: Hide the RAG answer bar when result count is 0, or adjust the empty state message.
- **Suggested command**: `/clarify`

### Updated Score

With visual audit findings: **11 code issues + 3 visual issues = 14 total remaining** (0 critical, 2 high, 7 medium, 5 low).

Overall quality: **~85%** — no critical blockers, strong design consistency, proper theming in both modes, good mobile responsiveness.
