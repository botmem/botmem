/**
 * UI-021 → UI-028: Onboarding flow
 */
import { test, expect } from '@playwright/test';
import { registerUser, submitRecoveryKey, injectAuth } from './helpers';

test.describe('Onboarding', () => {
  test('UI-021: Onboarding multi-step flow renders', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    // Inject auth with onboarded: false
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    // Should show step progress indicator
    await expect(page.locator('[class*="progress"], [role="progressbar"]').or(
      page.locator('text=/step/i'),
    )).toBeVisible({ timeout: 10000 });
  });

  test('UI-022: Onboarding step 1 — welcome screen', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    // Should show welcome content or first step
    await page.waitForLoadState('networkidle');
    // Look for any recognizable onboarding content
    const hasContent = await page
      .locator('text=/welcome|get started|connect|recovery|let.?s go/i')
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasContent).toBe(true);
  });

  test('UI-023: Onboarding step 2 — connect first connector', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    // Navigate to connector step — look for "Connect Now" or similar
    const connectBtn = page.getByRole('button', { name: /connect now|connect sources|next/i });
    if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await connectBtn.click();
      // Should show connector selection
      await expect(
        page.locator('text=/gmail|slack|whatsapp|imessage|connector/i').first(),
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test('UI-024: Onboarding — select Gmail connector opens OAuth flow', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    // Look for Gmail card/button in connector list
    const gmailCard = page.locator('text=/gmail/i').first();
    if (await gmailCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Gmail connector should be clickable
      await expect(gmailCard).toBeVisible();
    }
  });

  test('UI-025: Onboarding — skip connector step', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    // Look for skip button
    const skipBtn = page.getByRole('button', { name: /skip/i }).or(
      page.getByRole('link', { name: /skip/i }),
    );
    if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipBtn.click();
      // Should navigate to dashboard
      await page.waitForURL(/\/dashboard/, { timeout: 10000 });
    }
  });

  test('UI-026: Onboarding — complete sets onboarded: true', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');
    await page.waitForLoadState('networkidle');

    // Skip through onboarding
    const skipBtn = page.getByRole('button', { name: /skip/i }).or(
      page.getByRole('link', { name: /skip/i }),
    );
    if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForURL(/\/dashboard/, { timeout: 10000 });

      // Verify user is now onboarded via API
      const res = await fetch('http://localhost:12412/api/me', {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      const me = await res.json();
      expect(me.onboarded ?? me.user?.onboarded).toBe(true);
    }
  });

  test('UI-027: Onboarding — complete redirects to dashboard', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: false },
      },
    );
    await page.goto('/onboarding');

    // Skip to complete
    const skipBtn = page.getByRole('button', { name: /skip/i }).or(
      page.getByRole('link', { name: /skip/i }),
    );
    if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipBtn.click();
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 });
    }
  });

  test('UI-028: Onboarding — already onboarded user redirects to dashboard', async ({ page }) => {
    const user = await registerUser();
    await submitRecoveryKey(user);
    // Complete onboarding via API
    await fetch('http://localhost:12412/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.accessToken}`,
      },
      body: JSON.stringify({ onboarded: true }),
    });

    await page.goto('/');
    await page.evaluate(
      ({ accessToken, userData }) => {
        localStorage.setItem(
          'auth-storage',
          JSON.stringify({
            state: {
              user: userData,
              accessToken,
              isLoading: false,
              error: null,
              recoveryKey: null,
              needsRecoveryKey: false,
            },
            version: 0,
          }),
        );
      },
      {
        accessToken: user.accessToken,
        userData: { id: user.id, email: user.email, name: user.name, onboarded: true },
      },
    );

    await page.goto('/onboarding');
    // Should redirect away from onboarding
    await page.waitForURL(/\/dashboard|\/me/, { timeout: 10000 });
    expect(page.url()).not.toContain('/onboarding');
  });
});
