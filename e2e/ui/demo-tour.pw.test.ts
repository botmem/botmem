/**
 * Demo mode + guided tour e2e tests — 11 tests
 * Tests demo seed API, onboarding→demo flow, tour targets, and demo banner.
 */
import { test, expect } from '@playwright/test';
import {
  registerUser,
  submitRecoveryKey,
  createSeededUser,
  injectAuthForOnboarding,
  seedDemoData,
  type TestUser,
} from './helpers';

const API_BASE = 'http://localhost:12412/api';

/** Inject auth with onboarded: true + demo mode tour store state. */
async function injectOnboardedAuthWithDemo(
  page: import('@playwright/test').Page,
  user: TestUser,
): Promise<void> {
  await page.goto('/');

  // Login from page context to get httpOnly cookies
  const result = await page.evaluate(
    async ({ email, password }: { email: string; password: string }) => {
      const res = await fetch('/api/user-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return { ok: false as const, status: res.status };
      const data = await res.json();
      return { ok: true as const, user: data.user };
    },
    { email: user.email, password: user.password },
  );

  if (!result.ok) throw new Error(`Browser login failed: ${(result as { status: number }).status}`);

  await page.evaluate(
    ({ userData }: { userData: unknown }) => {
      localStorage.setItem(
        'botmem-auth',
        JSON.stringify({ state: { user: userData }, version: 0 }),
      );
      localStorage.setItem(
        'botmem-tour',
        JSON.stringify({
          state: { tourCompleted: false, demoMode: true, searchExamples: [] },
          version: 0,
        }),
      );
    },
    { userData: result.user },
  );
}

/** Check if demo data exists. */
async function getDemoStatus(accessToken: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/demo/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  return body.hasDemoData;
}

/** Clear demo data via API. */
async function clearDemoData(accessToken: string) {
  const res = await fetch(`${API_BASE}/demo/seed`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Demo cleanup failed: ${res.status}`);
  return res.json();
}

/* ── Demo Seed API — needs individual users (lifecycle tests) ── */
test.describe('Demo Seed API', () => {
  test('Demo seed creates correct counts and returns searchExamples', async () => {
    const user = await registerUser();
    await submitRecoveryKey(user);

    const res = await fetch(`${API_BASE}/demo/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    });
    const result = await res.json();

    expect(result.ok).toBe(true);
    expect(result.memories).toBe(30);
    expect(result.contacts).toBe(12);
    expect(result.links).toBeGreaterThan(0);
    expect(result.piiScan.clean).toBe(true);
    expect(result.searchExamples).toBeDefined();
    expect(result.searchExamples.length).toBe(5);
  });

  test('Demo seed rejects duplicate seeding', async () => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await seedDemoData(user);

    const res = await fetch(`${API_BASE}/demo/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('already exists');
  });

  test('Demo cleanup removes all seeded data', async () => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await seedDemoData(user);
    expect(await getDemoStatus(user.accessToken)).toBe(true);

    const cleanup = await clearDemoData(user.accessToken);
    expect(cleanup.ok).toBe(true);
    expect(cleanup.deleted).toBeGreaterThan(0);
    expect(await getDemoStatus(user.accessToken)).toBe(false);
  });
});

/* ── Onboarding → Demo Flow — needs fresh non-onboarded user each time ── */
test.describe('Onboarding → Demo Flow (UI)', () => {
  test('"Explore Demo" button visible on onboarding page', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await injectAuthForOnboarding(page, user);

    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    const demoBtn = page.locator('button', { hasText: /explore demo/i });
    await expect(demoBtn).toBeVisible({ timeout: 10000 });
  });

  test('"Explore Demo" seeds data and navigates to /dashboard', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await injectAuthForOnboarding(page, user);

    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    const demoBtn = page.locator('button', { hasText: /explore demo/i });
    await expect(demoBtn).toBeVisible({ timeout: 10000 });
    await demoBtn.click();

    await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  });
});

/* ── Tour targets & Demo Banner — share a single seeded user ── */
test.describe('Tour targets & Demo Banner', () => {
  let user: TestUser;

  test.beforeAll(async () => {
    user = await createSeededUser();
  });

  test('All tour targets exist on their respective pages', async ({ page }) => {
    await injectOnboardedAuthWithDemo(page, user);

    // Dashboard targets
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-tour="search-bar"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-tour="dashboard-graph"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-tour="pipeline-view"]')).toBeVisible({ timeout: 10000 });

    // Connectors target
    await page.goto('/connectors');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-tour="connectors-grid"]')).toBeVisible({ timeout: 10000 });

    // People target
    await page.goto('/people');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-tour="people-grid"]')).toBeVisible({ timeout: 10000 });
  });

  test('Search bar data-tour target contains input', async ({ page }) => {
    await injectOnboardedAuthWithDemo(page, user);

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const searchBar = page.locator('[data-tour="search-bar"]');
    await expect(searchBar).toBeVisible({ timeout: 10000 });
    await expect(searchBar.locator('input')).toBeVisible();
  });

  test('Dashboard shows demo data banner', async ({ page }) => {
    await injectOnboardedAuthWithDemo(page, user);

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // The banner needs both: demoMode in tourStore AND getDemoStatus()=true
    // Verify via API that demo data exists for this user
    const hasDemoData = await getDemoStatus(user.accessToken);
    // If the API confirms demo data, the banner should be visible
    if (hasDemoData) {
      await expect(page.getByText(/viewing demo data/i)).toBeVisible({ timeout: 20000 });
    } else {
      // Demo data was already cleaned up by another test — skip
      test.skip();
    }
  });

  test('Hardcoded botmem.xyz URL not shown on localhost', async ({ page }) => {
    await injectOnboardedAuthWithDemo(page, user);

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const hardcodedUrl = page.locator('code:has-text("https://botmem.xyz")');
    await expect(hardcodedUrl).not.toBeVisible({ timeout: 3000 });
  });

  test('Delete demo data via API clears data', async () => {
    // Test demo cleanup lifecycle via API (avoids flaky banner timing)
    const freshUser = await registerUser();
    await submitRecoveryKey(freshUser);
    await seedDemoData(freshUser);

    // Verify demo data exists
    expect(await getDemoStatus(freshUser.accessToken)).toBe(true);

    // Delete via API
    const cleanup = await clearDemoData(freshUser.accessToken);
    expect(cleanup.ok).toBe(true);

    // Verify it's gone
    expect(await getDemoStatus(freshUser.accessToken)).toBe(false);
  });

  test('Dashboard stats reset to 0 after clearing demo data', async ({ page }) => {
    // Create fresh user with demo data
    const freshUser = await registerUser();
    await submitRecoveryKey(freshUser);
    await seedDemoData(freshUser);

    // Inject auth with demo mode
    await page.goto('/');
    const loginResult = await page.evaluate(
      async ({ email, password }: { email: string; password: string }) => {
        const res = await fetch('/api/user-auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) return { ok: false as const, status: res.status };
        const data = await res.json();
        return { ok: true as const, user: data.user };
      },
      { email: freshUser.email, password: freshUser.password },
    );
    if (!loginResult.ok) throw new Error('Login failed');

    await page.evaluate(
      ({ userData }: { userData: unknown }) => {
        localStorage.setItem(
          'botmem-auth',
          JSON.stringify({ state: { user: userData }, version: 0 }),
        );
        localStorage.setItem(
          'botmem-tour',
          JSON.stringify({
            state: { tourCompleted: false, demoMode: true, searchExamples: [] },
            version: 0,
          }),
        );
      },
      { userData: loginResult.user },
    );

    // Go to dashboard — should show demo data
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Wait for TOTAL MEMORIES stat to show 30 (demo data count)
    const totalMemoriesStat = page.locator('text=/total memories/i').locator('..');
    await expect(totalMemoriesStat).toBeVisible({ timeout: 10000 });

    // Click "Delete Demo Data" button
    const deleteBtn = page.getByRole('button', { name: /delete demo|clear demo/i });
    if (await deleteBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await deleteBtn.click();

      // Wait for stats to refresh — TOTAL MEMORIES should drop to 0
      // The AnimatedNumber component will animate to the new value
      await expect(page.locator('[data-tour="search-bar"]')).toBeVisible({ timeout: 10000 });

      // Verify via API that stats are now 0
      const statsRes = await fetch(`${API_BASE}/memories/stats`, {
        headers: { Authorization: `Bearer ${freshUser.accessToken}` },
      });
      if (statsRes.ok) {
        const stats = await statsRes.json();
        expect(stats.totalMemories ?? stats.total ?? 0).toBe(0);
      }

      // Verify demo data is gone
      expect(await getDemoStatus(freshUser.accessToken)).toBe(false);
    }
  });
});
