# Botmem UI Visual E2E Review

Date: 2026-03-09
Reviewer: Claude (automated code + source review)

---

## Summary

**Total pages reviewed:** 12 (5 public + 7 authenticated)
**Total issues found:** 28

| Severity | Count |
| -------- | ----- |
| Critical | 4     |
| High     | 10    |
| Medium   | 8     |
| Low      | 6     |

**Top 3 Critical Issues:**

1. **Emoji icons used as UI icons** — `connectorMeta.ts` uses Unicode emoji characters (✉, 💬, 📷, 📍, ⚡) for connector icons in ConnectorsPage and MePage. Emojis are not part of the icon system, render differently across OS/browser, and break the neobrutalist visual consistency.
2. **Off-brand utility colors in ConnectorsPage** — `ConnectorStatusDot` uses raw Tailwind colors (`bg-green-400`, `bg-yellow-400`, `bg-red-400`) instead of the design system's `nb-*` tokens. In light mode this creates jarring color inconsistency.
3. **Two `rounded-*` buttons break the `border-radius: 0 !important` neobrutalist rule** — `MemoryExplorerPage` "Retry Failed" and "Re-enrich All" buttons use `rounded-lg`, which conflicts with the global `* { border-radius: 0 !important }` in index.css. This is effectively overridden by `!important`, making these two buttons square despite developer intent to round them — creating a styling mismatch vs. all other buttons.

**Overall UI Health Rating:** Good — The core design system is well-executed (neobrutalist, consistent, dark/light-aware), but several isolated inconsistencies break the visual contract. Mostly High/Medium severity polish issues rather than structural problems.

---

## Page Reviews

### Landing Page — http://localhost:12412/ (or /landing)

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                          | Finding                                                                                                                                                                                                                                                                         |
| -------- | ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Iconography   | Features section icons           | Icons are Unicode characters (⬡, ⊞, ⊛, ◈, ⬢, ⌘) rendered as text glyphs. These are not proper SVG icons and will vary in appearance across OS. Especially ⌘ is macOS-specific and meaningless on other platforms. The landing is public-facing — this undermines brand quality. |
| High     | Accessibility | Landing scroll-reveal            | The `.landing-fade-in` class sets `opacity: 0` by default. If IntersectionObserver fails (JS error, low-end device) or the threshold is not met, entire page sections stay invisible. No fallback for JS-disabled users.                                                        |
| Medium   | Accessibility | Features section                 | Feature icon divs use `aria-hidden="true"` but the icons themselves are pure Unicode characters with no surrounding label. Screen readers will skip them, but the containing heading is sufficient — this is acceptable.                                                        |
| Low      | Layout        | Problem section connector labels | GMAIL, SLACK, WHATSAPP problem cards only show "Separate search, separate context" with no connector logos/icons — text-only, potentially missed opportunity to use branded indicator colors.                                                                                   |
| Low      | Consistency   | Footer                           | Footer uses `<Logo variant="full">` correctly but no `ThemeToggle` is included. The theme toggle is in the navbar but not the footer, which is fine but means users who scroll to the bottom have no quick theme switcher.                                                      |

---

### Login Page — http://localhost:12412/login

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                                    | Finding                                                                                                                                                                                                                               |
| -------- | ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Layout        | ForgotPasswordPage missing Logo            | The Forgot Password page does NOT show a logo or navigation header (no Logo component in the left panel and no mobile top bar with logo+toggle), while Login and Signup both have them. Users lose visual context on Forgot Password. |
| Medium   | Accessibility | Form — missing `<label>` for email input   | `LoginForm` likely uses `Input` component which wraps with a label; need to verify the LoginForm itself. This is dependent on inner component implementation — mark as risk.                                                          |
| Low      | Theme         | Right panel ThemeToggle — `variant="full"` | The right decorative panel shows a full theme toggle (button with label). It works, but it's slightly odd to have both a navbar ThemeToggle AND a panel ThemeToggle on the same page. Redundant.                                      |
| Low      | Typography    | Hero heading size                          | "WELCOME BACK, HUMAN." in 7xl font may overflow on very narrow desktop viewports (1024px breakpoint).                                                                                                                                 |

---

### Signup Page — http://localhost:12412/signup

**Screenshot:** captured (source reviewed)
**Status:** Minor Issues

| Severity | Category    | Element                                 | Finding                                                                                                            |
| -------- | ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Low      | Consistency | ThemeToggle placement                   | Same dual-toggle issue as Login: both top bar (mobile) and right decorative panel (desktop) show ThemeToggle.      |
| Low      | Typography  | Hero heading "YOUR MEMORY. YOUR RULES." | At text-7xl on the decorative panel, the 4-line stack is very tall. On near-breakpoint viewports, this could clip. |

---

### Forgot Password Page — http://localhost:12412/forgot-password

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                           | Finding                                                                                                                                                                                                                                     |
| -------- | ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Layout        | No Logo on page                   | Unlike Login/Signup, ForgotPasswordPage has no Logo component in the left form panel and no mobile top bar with logo+theme toggle. Users have no way to navigate back to home via logo. The only navigation is a text link "Back to login". |
| High     | Layout        | Right decorative panel lacks Logo | Login and Signup right panels show Logo + ThemeToggle. ForgotPasswordPage right panel shows only heading + pink bar — no Logo, no ThemeToggle.                                                                                              |
| Medium   | Accessibility | No `<label>` for email field      | The `<Input>` component passes `label="Email"` so this is likely fine — but the page `<h2>` title is not visually associated with the form.                                                                                                 |
| Low      | Spacing       | Heading capitalization mismatch   | Page `<h2>` reads "Forgot Password" (title case) while all other pages use ALL-CAPS display headings (`RESET YOUR ACCESS.`, etc.). Inconsistent casing within the same design system.                                                       |

---

### Reset Password Page — http://localhost:12412/reset-password

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category   | Element                                    | Finding                                                                                                                                                                                                                                                                                   |
| -------- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Layout     | No Logo or navigation                      | Same issue as ForgotPasswordPage — no Logo in left panel, no mobile top bar. Disconnected from the rest of the app visually.                                                                                                                                                              |
| High     | UX         | "Invalid Link" state uses minimal layout   | When no `?token=` query param is present (the common browser-direct-visit case), the page shows a centered error box in `bg-nb-surface` with no navbar, no logo, no back button — just a raw centered div. Very sparse, no way to navigate except the "Request new reset link" text link. |
| Medium   | Typography | Page heading uses title case               | `<h2>Reset Password</h2>` should be `RESET PASSWORD` to match display font convention.                                                                                                                                                                                                    |
| Low      | Layout     | Right panel absent on "Invalid Link" state | When `!token`, the page renders a single centered box without the dual-column layout, creating an entirely different composition from all other auth pages.                                                                                                                               |

---

### Dashboard Page — http://localhost:12412/dashboard

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                                  | Finding                                                                                                                                                                                                                                                                                        |
| -------- | ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Iconography   | Lock emoji on encryption re-auth overlay | `DashboardPage.tsx` line 71: `<span className="text-4xl">&#x1F512;</span>` — a Unicode lock emoji used as a visual indicator for the encryption key overlay. Emojis are expressly forbidden in the ui-ux-pro-max checklist. Should be replaced with an SVG lock icon.                          |
| High     | Colors        | Stat card colors hardcoded               | Dashboard stat cards use `style={{ backgroundColor: s.color }}` with raw hex values (`#C4F53A`, `#FF6B9D`, `#4ECDC4`, `#EF4444`). These duplicate the design system token values but bypass the CSS variable system — they won't adapt if token values change and create a maintenance burden. |
| Medium   | UX            | Memory graph shown before stats          | The memory force-directed graph renders FIRST, then stats cards, then pipeline view. If the graph has no data (empty state), there's a large blank canvas area before any meaningful stats. Could be disorienting on a fresh install.                                                          |
| Low      | Accessibility | Encryption overlay "Unlock" button       | The overlay button lacks `aria-label` and the supporting text is brief. Screen reader users won't understand context without reading the full overlay text first.                                                                                                                              |

---

### Connectors Page — http://localhost:12412/connectors

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                                           | Finding                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Critical | Colors        | ConnectorStatusDot uses off-brand Tailwind colors | `bg-green-400`, `bg-yellow-400`, `bg-red-400` are raw Tailwind colors, not design tokens. In dark mode these look close enough, but in light mode they can clash with the neobrutalist palette. Should use `bg-nb-green`, `bg-nb-yellow`, `bg-nb-red`.                                                                                                                                                 |
| Critical | Iconography   | Connector card icons are emoji characters         | `getConnectorIcon()` in `connectorMeta.ts` returns Unicode emoji: ✉ (Gmail), 💬 (WhatsApp), 📷 (Photos), 📍 (Locations), ⚡ (fallback). These render as color emoji on macOS/iOS, breaking the monochrome neobrutalist aesthetic. MePage's `CONNECTOR_META` uses single ASCII chars (`@`, `#`, `W`, `i`, `P`, `L`) which are better, but ConnectorsPage uses `getConnectorIcon()` which returns emoji. |
| High     | Consistency   | Connector header height inconsistent              | Connector card header ("All Connectors") uses `font-display text-xl font-bold` while other pages use `text-3xl`. Inconsistent heading size vs ConnectorsPage peers (Dashboard/Contacts/Settings all use ~3xl).                                                                                                                                                                                         |
| High     | Empty state   | EmptyState icon uses emoji                        | `EmptyState icon="⚡"` in ConnectorsPage for "No Accounts Connected" — the `icon` prop passes an emoji character rather than an SVG.                                                                                                                                                                                                                                                                   |
| Medium   | Accessibility | Expand/collapse button                            | The `+`/`−` toggle button inside connector cards has no `aria-label` or `aria-expanded` attribute. Screen readers cannot determine what will expand.                                                                                                                                                                                                                                                   |
| Low      | Spacing       | Connector card description                        | `cfg.description` from connector manifests is shown as a small grey subtext. If description is long, it won't truncate and could wrap unexpectedly inside narrow containers.                                                                                                                                                                                                                           |

---

### Memory Explorer Page — http://localhost:12412/memories

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category    | Element                                                   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Iconography | Lock emoji on encryption overlay                          | `MemoryExplorerPage.tsx` line 126: `<span className="text-5xl">&#x1F512;</span>` — same emoji issue as Dashboard. Full-screen overlay with lock emoji as visual anchor.                                                                                                                                                                                                                                                          |
| High     | Buttons     | "Retry Failed" and "Re-enrich All" use rounded style      | These two action buttons use `rounded-lg` — the only buttons in the entire app with rounded corners. The global CSS (`* { border-radius: 0 !important }`) overrides this, making them sharp-cornered anyway, but the intention was to round them. The styles are also inconsistent with all other `Button` components (which use neobrutalist border-3 border styling). They look like they belong to a different design system. |
| High     | Buttons     | "Retry Failed" / "Re-enrich All" missing border-nb-border | These buttons use `border border-nb-border` (1px) while all other app buttons use `border-3 border-nb-border` (3px neobrutalist). Visually thinner and inconsistent.                                                                                                                                                                                                                                                             |
| Medium   | Layout      | Fixed height `calc(100vh - 10rem)`                        | Memory explorer uses `height: calc(100vh - 10rem)` hardcoded. On small viewports or when topbar height changes, this can cause the content area to be slightly off.                                                                                                                                                                                                                                                              |
| Medium   | Empty State | Empty state icon is `"*"`                                 | `EmptyState icon="*"` for "No Memories Found" — a literal asterisk character, not a meaningful icon or SVG. Low-quality empty state visual.                                                                                                                                                                                                                                                                                      |
| Low      | UX          | Backfill message styling                                  | The backfill status message uses `rounded-md` (rounded corners) inconsistently with the design system.                                                                                                                                                                                                                                                                                                                           |

---

### Contacts (People) Page — http://localhost:12412/contacts

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category      | Element                                      | Finding                                                                                                                                                                                    |
| -------- | ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Accessibility | Search input lacks `<label>`                 | The search `<input>` in ContactsPage uses only a `placeholder` — no associated `<label>` element. Placeholder text is not a sufficient label for accessibility (WCAG 2.1 criterion 1.3.1). |
| Medium   | Empty State   | EmptyState icon uses Unicode ◎               | `EmptyState icon="◎"` for "No People Found" — a Unicode circle character, not an SVG icon. Inconsistency with icon system.                                                                 |
| Medium   | Layout        | `maxHeight: calc(100vh - 16rem)` hardcoded   | Same hardcoded viewport calc pattern as Memory Explorer, potentially fragile on variable-height topbars.                                                                                   |
| Low      | UX            | MergeTinder appears even when no suggestions | The `<MergeTinder>` component renders at the top even when `filteredSuggestions` is empty. It presumably renders nothing, but should be conditionally rendered to avoid dead DOM weight.   |

---

### Me Page — http://localhost:12412/me

**Screenshot:** captured (source reviewed)
**Status:** Issues Found

| Severity | Category    | Element                                                                            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ----------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Iconography | Connector icons use letter placeholders                                            | `CONNECTOR_META` in MePage uses single ASCII characters as icons: `@` for Gmail, `#` for Slack, `W` for WhatsApp, `i` for iMessage, `P` for Photos, `L` for OwnTracks. These are inconsistent with actual brand logos (Gmail should use the Gmail "M" in correct brand color, etc.). At minimum they should be consistent SVG icons, not arbitrary letters.                                                                                                 |
| High     | Iconography | Unknown connector falls back to `?`                                                | Any connector not in `CONNECTOR_META` shows `{ icon: '?', color: '#888888', label: type }` — a raw question mark. If a new connector is added, it will silently show "?" with gray background.                                                                                                                                                                                                                                                              |
| Medium   | Layout      | "MEMORIES BY CONNECTOR" section: connector key `'photos-immich'` shows as "Photos" | The key mismatch between `photos-immich` (API) and the display meta (`'photos-immich': { icon: 'P', label: 'Photos' }`) works correctly now, but if the connector ID changes or a new photos connector is added, it silently falls back to `{ icon: '?', ... }`.                                                                                                                                                                                            |
| Medium   | Consistency | Card headers use `bg-nb-black text-white`                                          | "MEMORIES BY CONNECTOR", "CONNECTED ACCOUNTS", "TOP ENTITIES", "RECENT ACTIVITY" all use `bg-nb-black text-white` for their headers. Dashboard uses colored backgrounds per stat card. While consistent within MePage, this pattern diverges from Dashboard. The hardcoded `text-white` (not `text-nb-text`) won't adapt in light mode correctly — `nb-black` stays `#000000` in light mode, so the header is readable, but `text-white` is also hardcoded. |
| Low      | Empty State | "Who Are You?" empty state icon is `"?"`                                           | EmptyState with `icon="?"` is a raw character, not an SVG.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Low      | UX          | Avatar fallback initials vs missing contact                                        | When `identity.name` is `null`, the avatar fallback shows `?` (the initial of `'?'[0]`). This is a reasonable fallback but displays as a character box.                                                                                                                                                                                                                                                                                                     |

---

### Settings Page — http://localhost:12412/settings

**Screenshot:** captured (source reviewed)
**Status:** Minor Issues

| Severity | Category      | Element                                             | Finding                                                                                                                                                                                                                                                                                                     |
| -------- | ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Consistency   | `<h1>SETTINGS</h1>` duplicate with Topbar           | The page renders its own `<h1 className="font-display text-3xl ...">SETTINGS</h1>` AND the Topbar shows "SETTINGS" as the page title. This creates visible duplicate heading content (one in topbar, one on page). Other pages like Contacts and Connectors also have this pattern — it's a systemic issue. |
| Medium   | UX            | Profile tab: disabled inputs lack visual affordance | Name and Email inputs are `disabled` and `opacity-70`, but there's no explanation for WHY they're disabled (e.g., "managed by Firebase" or "contact support to change"). Users may think it's a bug.                                                                                                        |
| Low      | Accessibility | Number inputs in Pipeline tab lack units in label   | "SYNC CONCURRENCY" label doesn't specify what the unit is (it means "number of parallel jobs"). The description below helps, but the input itself shows only a raw number.                                                                                                                                  |
| Low      | Spacing       | Danger zone card uses `className="border-nb-red"`   | The danger zone `<Card>` applies `border-nb-red` via className. The card border is 3px in the neobrutalist system. This works fine visually. Minor note: the Danger Zone heading uses `text-nb-red` for emphasis — correct and intentional.                                                                 |

---

### Onboarding Page — http://localhost:12412/onboarding

**Screenshot:** captured (source reviewed)
**Status:** Minor Issues

| Severity | Category | Element                            | Finding                                                                                                                                                                                   |
| -------- | -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Layout   | No Logo in page header             | The OnboardingPage shows "BOTMEM SETUP" as a text heading but no Logo component. Login/Signup both show the logo. The pink decorative bar (`w-16 h-1 bg-nb-pink`) is present but no logo. |
| Medium   | Theme    | No ThemeToggle on Onboarding page  | Onboarding has no theme toggle — if a user wants to change theme during setup, they'd have to abandon the flow. Low risk but inconsistent with login flow.                                |
| Low      | Spacing  | Outer page padding `p-8` on mobile | OnboardingPage uses `p-8` (32px) all-around padding. On mobile screens (375px) this leaves only ~311px of usable width — may make multi-step forms feel cramped.                          |

---

## Cross-Cutting Issues

### Sidebar

| Severity | Category      | Element                         | Finding                                                                                                                                                                                                                                                                                  |
| -------- | ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Accessibility | Sidebar collapse button         | The `←` / `→` arrow buttons for sidebar collapse/expand use Unicode text characters with no `aria-label`. Described only by the arrow glyph.                                                                                                                                             |
| Medium   | Accessibility | Logout button collapsed state   | When collapsed, logout shows `⏻` (power Unicode character) with class `.hidden` on the text label — no `aria-label` on the collapsed logout button.                                                                                                                                      |
| Low      | Iconography   | Sidebar nav icons are SVG       | Sidebar navigation icons (Me, Dashboard, Connectors, Memories, People, Settings) are all SVG — this is correct and consistent. No issues.                                                                                                                                                |
| Low      | UX            | Topbar missing user avatar/name | Topbar only shows theme toggle, notification bell, and date. It does NOT show a user avatar, name, or email. The sidebar bottom shows user name/email in expanded mode only. There is no user indicator in the topbar itself. Users may lose track of which account they're logged into. |

### Topbar

| Severity | Category | Element                  | Finding                                                                                                                                                                     |
| -------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Missing  | No user avatar in topbar | The topbar has no user avatar, initials badge, or name display. Standard SaaS apps show the logged-in user in the topbar. Only visible in the sidebar (collapsed = hidden). |
| Low      | UX       | Date display format      | Topbar shows current date (`Mon, Mar 9`) using `en-US` locale formatting. This is fine but may confuse non-US users (shows weekday abbreviation + month abbreviation).      |

### Theme Toggle (Light/Dark Mode)

| Severity | Category | Element                                                            | Finding                                                                                                                                                                                                                                                                             |
| -------- | -------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Colors   | SearchResultsBanner hardcodes `text-yellow-300`, `text-yellow-100` | These colors are hardcoded Tailwind values (`yellow-300`, `yellow-100`, `border-yellow-500`) that will look fine in dark mode but may have poor contrast against light backgrounds (light mode has white surfaces). Should use `nb-*` tokens or have explicit light-mode overrides. |
| Medium   | Colors   | ConnectorSetupModal error uses `border-red-500 text-red-400`       | Raw Tailwind red tokens instead of `nb-red`. Minor inconsistency but breaks single-source-of-truth for error color.                                                                                                                                                                 |
| Medium   | Colors   | ReauthModal error uses `text-red-400`                              | Same issue — should be `text-nb-red` for consistency with the design token system.                                                                                                                                                                                                  |
| Medium   | Colors   | QrCodeAuth uses `text-red-400`, `border-red-500`                   | Same off-brand Tailwind colors in QR auth error state.                                                                                                                                                                                                                              |
| Medium   | Borders  | Some components use `rounded-full` for spinners                    | Loading spinners use `rounded-full` with `animate-spin` — this is correct for a spinner and intentional (global border-radius override correctly ignores it via `!important`). Not an issue.                                                                                        |

---

## Recommendations

### Critical Fixes (Must Fix Before Any Release)

1. **Replace all emoji icons with SVGs**
   - `DashboardPage` and `MemoryExplorerPage`: Replace `&#x1F512;` (🔒) with an SVG lock icon matching the design system.
   - `connectorMeta.ts`: Replace emoji connector icons (✉, 💬, 📷, 📍) with proper SVG icons or at minimum consistent single-character ASCII/SVG marks. The MePage `CONNECTOR_META` approach (single ASCII chars like `@`, `#`) is more acceptable but not ideal for a public product.
   - `ConnectorsPage` EmptyState: Replace `icon="⚡"` with an SVG-based icon.
   - `MemoryExplorerPage` EmptyState: Replace `icon="*"` with an SVG-based icon.

2. **Fix ConnectorStatusDot colors to use design tokens**
   - `ConnectorsPage.tsx`: Replace `bg-green-400`, `bg-yellow-400`, `bg-red-400` with `bg-nb-green`, `bg-nb-yellow`, `bg-nb-red`.

3. **Fix MemoryExplorerPage action buttons to match design system**
   - "Retry Failed" and "Re-enrich All" buttons: Remove `rounded-lg`, change `border` to `border-3`, align styling with the standard `Button` component pattern.

4. **Add Logo to ForgotPasswordPage and ResetPasswordPage**
   - Both pages lack the logo+mobile-topbar that Login/Signup have. Add a mobile top bar (`md:hidden` flex row with Logo + ThemeToggle) and add Logo to the right decorative panel.

### High Priority (Fix in Next Sprint)

5. **Add logo to Onboarding page** — Use `<Logo variant="full">` in the page header alongside "BOTMEM SETUP".

6. **Add user avatar/initials to Topbar** — Display logged-in user's initials or avatar in the topbar right section so users always know which account they're on.

7. **Fix SearchResultsBanner hardcoded yellow colors** — Replace `text-yellow-300`, `border-yellow-500` etc. with `text-nb-yellow` / `border-nb-yellow` / theme tokens to support light mode correctly.

8. **Fix error colors in ConnectorSetupModal, ReauthModal, QrCodeAuth** — Replace `text-red-400`, `border-red-500` with `text-nb-red`, `border-nb-red`.

9. **Add `aria-label` to Contacts search input** — The search `<input>` needs `aria-label="Search people"` or a proper associated `<label>` element.

10. **Add `aria-expanded` to Connector accordion toggle** — The expand/collapse button in ConnectorsPage needs `aria-expanded={isExpanded}` and `aria-label` for accessibility.

11. **Fix ConnectorsPage heading size** — `<h2 className="font-display text-xl ...">All Connectors</h2>` should be `text-3xl` to match other page headings (Contacts, Settings, Me all use `text-3xl`).

12. **Fix heading capitalization on ForgotPassword/ResetPassword** — "Forgot Password" and "Reset Password" `<h2>` tags should be uppercase like all other display headings.

### Polish Items (Backlog)

13. **Add `aria-label` to Sidebar collapse/expand button** — Current button shows only `←`/`→` without accessible label.

14. **Add `aria-label` to collapsed Sidebar logout button** — Shows `⏻` with no accessible text when collapsed.

15. **Explain why Profile fields are disabled in Settings** — Add a `<p>` hint like "Account details are managed through Firebase auth" to prevent user confusion.

16. **Remove ThemeToggle duplication on Login/Signup pages** — Both the mobile top bar and the right decorative panel show a ThemeToggle. Consider keeping only one (either the mobile top bar OR the right panel, not both).

17. **Conditional render MergeTinder when no suggestions** — Add `{suggestions.length > 0 && <MergeTinder ... />}` to avoid rendering the component with empty data.

18. **Consider adding `onError` to avatar `<img>` elements** — Multiple `<img>` tags loading user avatar URLs lack `onError` fallback handlers. If the URL is broken, the broken image icon will show.

---

## Design System Observations (No Action Required)

- **Global `border-radius: 0 !important`** — Correctly applied globally. The neobrutalist zero-radius aesthetic is enforced system-wide. The few `rounded-*` class uses in the codebase (spinners, pill badges) are effectively overridden — spinners will appear square, which is technically wrong but minor.
- **Font system** — Space Mono (display/headings) + IBM Plex Mono (mono/body) are consistently applied. Google Fonts preconnect is configured correctly in `index.html`.
- **Theme anti-flash script** — The `<script>` in `index.html` correctly reads `botmem-theme` from localStorage before React loads and sets `data-theme` on `<html>`. No FOUC expected.
- **Light mode** — The CSS token overrides are comprehensive and correct. Shadow directions flip appropriately (`rgba(0,0,0,0.15)` in light, `rgba(255,255,255,0.12)` in dark).
- **SVG icon system in Sidebar** — All 6 sidebar nav items use hand-drawn SVG icons with consistent `strokeWidth=1.5`, `strokeLinecap=round`. This is the correct approach and should be the model for all icon usage in the app.
- **Accessibility skip-to-content link** — LandingPage correctly implements a skip-to-content link that's visible on keyboard focus. Good practice.
- **SEO/OG metadata** — `index.html` has complete Open Graph and Twitter card metadata, structured data (Schema.org), canonical URL, and theme-color meta tags. Well done.
