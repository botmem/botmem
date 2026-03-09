---
phase: quick-7
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md
autonomous: true
requirements: [QUICK-7]

must_haves:
  truths:
    - 'Every app page has been visited and screenshot captured'
    - 'Visual findings are documented with page, element, severity, and description'
    - 'UI-REVIEW.md exists as a complete markdown report'
  artifacts:
    - path: '.planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md'
      provides: 'Full visual E2E review report'
  key_links:
    - from: 'browser automation'
      to: 'UI-REVIEW.md'
      via: 'screenshot + accessibility tree inspection per page'
---

<objective>
Perform a full visual E2E review of the Botmem web app at http://localhost:12412. Visit every page, capture screenshots, inspect the UI using the ui-ux-pro-max checklist, and produce a comprehensive markdown report of all visual, layout, and UX issues found.

Purpose: Identify broken, inconsistent, or low-quality UI elements before the next release cycle.
Output: UI-REVIEW.md with page-by-page findings, severity ratings, and a summary.
</objective>

<execution_context>
@/Users/amr/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md

The app runs at http://localhost:12412.
Auth: email = amroessams@gmail.com, password = 5\*YQJe4nzZ0TR388D5a^mpxp%Cl

Pages to review (from apps/web/src/pages/):

- / (LandingPage)
- /login (LoginPage)
- /signup (SignupPage)
- /forgot-password (ForgotPasswordPage)
- /reset-password (ResetPasswordPage)
- /dashboard (DashboardPage) — requires login
- /connectors (ConnectorsPage) — requires login
- /memory (MemoryExplorerPage) — requires login
- /contacts (ContactsPage) — requires login
- /me (MePage) — requires login
- /settings (SettingsPage) — requires login
- /onboarding (OnboardingPage) — requires login

Use the browser skill (agent-browser / mcp**claude-in-chrome**\* tools) for all navigation and screenshot capture.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Review unauthenticated pages</name>
  <files>.planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md</files>
  <action>
    Use browser automation to visit and review every public (unauthenticated) page.

    For each page, follow this sequence:
    1. Navigate to the page URL
    2. Take a screenshot
    3. Take a full accessibility snapshot (agent-browser snapshot)
    4. Inspect visually and via snapshot for issues across all checklist dimensions below

    Pages to cover in this task:
    - http://localhost:12412/ (Landing)
    - http://localhost:12412/login
    - http://localhost:12412/signup
    - http://localhost:12412/forgot-password
    - http://localhost:12412/reset-password

    UI-UX-Pro-Max Evaluation Checklist (apply to every page):
    - COLORS: Inconsistent brand colors, wrong contrast ratios, hardcoded colors clashing with theme
    - ICONOGRAPHY: Missing icons, wrong icons for context, inconsistent icon sizes or weights
    - LOGO: Logo missing, wrong size, pixelated, misaligned, or absent from expected locations
    - TYPOGRAPHY: Inconsistent font weights/sizes, truncated text, overflow outside containers
    - LAYOUT: Misaligned elements, broken grid/flex, overlapping elements, excessive whitespace or crowding
    - SPACING: Inconsistent padding/margin, elements touching edges
    - BUTTONS & FORMS: Broken hover/focus states, missing labels, wrong input types, disabled states unclear
    - EMPTY STATES: Missing empty state UI where content would be shown
    - RESPONSIVE: Obvious mobile/narrow breakpoint failures (test at ~375px if possible)
    - ACCESSIBILITY: Missing alt text, unlabeled interactive elements, no focus ring visible
    - LOADING STATES: Spinners missing or stuck
    - ERROR STATES: Error messages missing, unhelpful, or unstyled
    - DARK/LIGHT MODE: If a theme toggle exists, verify both modes look correct on each page
    - CONSISTENCY: Inconsistent component styles vs other pages

    Begin creating UI-REVIEW.md during this task. Use this structure:

    ```
    # Botmem UI Visual E2E Review
    Date: [today]
    Reviewer: Claude (automated browser review)

    ## Summary
    [Fill in after Task 2]

    ## Page Reviews

    ### [Page Name] — [URL]
    **Screenshot:** [note: captured]
    **Status:** [Pass / Issues Found]

    | Severity | Category | Element | Finding |
    |----------|----------|---------|---------|
    | Critical | Colors | ... | ... |
    | High | Layout | ... | ... |
    | Medium | Iconography | ... | ... |
    | Low | Typography | ... | ... |

    ---
    ```

    Severity definitions:
    - Critical: Broken, unusable, or completely absent (e.g., white text on white bg, invisible button)
    - High: Visually jarring, clearly wrong, degrades UX significantly
    - Medium: Inconsistent with the rest of the app, noticeable to users
    - Low: Minor polish issues, nice-to-have improvements

  </action>
  <verify>UI-REVIEW.md exists and contains sections for all 5 unauthenticated pages</verify>
  <done>All unauthenticated pages reviewed and findings written to UI-REVIEW.md</done>
</task>

<task type="auto">
  <name>Task 2: Review authenticated pages and finalize report</name>
  <files>.planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md</files>
  <action>
    Log in first, then visit all authenticated pages.

    Login sequence:
    1. Navigate to http://localhost:12412/login
    2. Fill email: amroessams@gmail.com
    3. Fill password: 5*YQJe4nzZ0TR388D5a^mpxp%Cl
    4. Submit and wait for redirect to dashboard

    Authenticated pages to review (same checklist as Task 1, applied to each):
    - http://localhost:12412/dashboard
    - http://localhost:12412/connectors
    - http://localhost:12412/memory
    - http://localhost:12412/contacts
    - http://localhost:12412/me
    - http://localhost:12412/settings
    - http://localhost:12412/onboarding

    Additional checks for authenticated pages:
    - SIDEBAR: Navigation items visible, icons correct, active state highlighted, logo present
    - TOPBAR: User avatar/initials displayed, user name/email readable, action buttons present
    - GRAPH ELEMENTS (MemoryExplorerPage): Force-directed graph rendered, nodes have colors/labels, edges visible, graph not blank
    - USER AVATARS: Avatar shown where expected (topbar, contacts list, me page), fallback initials if no photo
    - DATA STATES: Empty states vs populated states both look correct
    - CONNECTORS PAGE: Connector cards have icons, connection status indicators visible
    - DASHBOARD: Stats/widgets layout correct, no broken card sections

    Also check the theme toggle (ThemeToggle component) if visible — switch between light/dark and note any issues.

    After reviewing all pages, finalize UI-REVIEW.md:
    1. Fill in the Summary section at the top:
       - Total pages reviewed
       - Total issues found (by severity count)
       - Top 3 most critical issues
       - Overall UI health rating (Excellent / Good / Needs Work / Poor)
    2. Add a "Recommendations" section at the end with prioritized action items grouped by:
       - Critical fixes (must fix before any release)
       - High priority (fix in next sprint)
       - Polish items (backlog)

  </action>
  <verify>UI-REVIEW.md contains all 7 authenticated page sections plus a complete Summary and Recommendations section</verify>
  <done>
    UI-REVIEW.md is complete with:
    - All 12 pages reviewed (5 public + 7 authenticated)
    - Every page has a findings table (even if "no issues found")
    - Summary section filled with issue counts and health rating
    - Recommendations section with prioritized action items
  </done>
</task>

</tasks>

<verification>
UI-REVIEW.md exists at .planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md and contains all 12 page sections, a Summary, and Recommendations.
</verification>

<success_criteria>

- All 12 app pages visited via browser automation
- Each page has visual findings documented with severity, category, element, and description
- Summary section quantifies total issues by severity
- Recommendations section provides actionable prioritized fixes
- Report is self-contained and readable without needing screenshots
  </success_criteria>

<output>
Report is written directly to .planning/quick/7-full-visual-e2e-review-of-all-app-functi/UI-REVIEW.md during execution — no separate SUMMARY.md needed for this quick task.
</output>
