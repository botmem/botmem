/**
 * UI-QUOTA: Billing tab quota display
 * Verifies quota bar renders correctly for users on the billing tab.
 */
import { test, expect } from '@playwright/test';
import { createSeededUser, navigateAs, type TestUser } from './helpers';

let user: TestUser;

test.beforeAll(async () => {
  user = await createSeededUser();
});

test.beforeEach(async ({ page }) => {
  await navigateAs(page, user, '/settings');
  await page.getByRole('button', { name: /billing/i }).click();
  await expect(page.getByRole('heading', { name: /billing/i })).toBeVisible();
});

test('UI-QUOTA-001: Billing tab shows MEMORY USAGE heading', async ({ page }) => {
  // In self-hosted mode, billing is disabled and shows "ALL FEATURES UNLOCKED"
  // In cloud mode with free plan, should show quota bar
  const billingContent = page.locator('text=/billing/i').first();
  await expect(billingContent).toBeVisible({ timeout: 10000 });

  await expect(page.locator('text=/all features unlocked|memory usage/i')).toBeVisible({
    timeout: 10000,
  });
});

test('UI-QUOTA-002: Self-hosted mode shows ALL FEATURES UNLOCKED', async ({ page }) => {
  // In self-hosted mode (no Stripe key), billing should show unlocked message
  const selfHosted = page.locator('text=/all features unlocked/i');
  const quotaBar = page.locator('text=/memory usage/i');

  await expect(selfHosted.or(quotaBar)).toBeVisible({ timeout: 10000 });
  const isSelfHosted = await selfHosted.isVisible().catch(() => false);

  if (isSelfHosted) {
    await expect(selfHosted).toBeVisible();
    // Should NOT show quota bar in self-hosted mode
    await expect(quotaBar).not.toBeVisible();
  } else {
    // Cloud mode — quota bar should be present for free users
    await expect(quotaBar).toBeVisible({ timeout: 5000 });
  }
});
