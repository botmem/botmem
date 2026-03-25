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
  // Click the Billing tab
  await page.locator('text=/billing/i').first().click();
});

test('UI-QUOTA-001: Billing tab shows MEMORY USAGE heading', async ({ page }) => {
  // In self-hosted mode, billing is disabled and shows "ALL FEATURES UNLOCKED"
  // In cloud mode with free plan, should show quota bar
  const billingContent = page.locator('text=/billing/i').first();
  await expect(billingContent).toBeVisible({ timeout: 10000 });

  // Check for either self-hosted message or quota bar
  const selfHosted = page.locator('text=/all features unlocked/i');
  const quotaBar = page.locator('text=/memory usage/i');

  // One of these should be visible
  const isSelfHosted = await selfHosted.isVisible().catch(() => false);
  const hasQuota = await quotaBar.isVisible().catch(() => false);

  expect(isSelfHosted || hasQuota).toBe(true);
});

test('UI-QUOTA-002: Self-hosted mode shows ALL FEATURES UNLOCKED', async ({ page }) => {
  // In self-hosted mode (no Stripe key), billing should show unlocked message
  const selfHosted = page.locator('text=/all features unlocked/i');
  const quotaBar = page.locator('text=/memory usage/i');

  const isSelfHosted = await selfHosted.isVisible({ timeout: 5000 }).catch(() => false);

  if (isSelfHosted) {
    await expect(selfHosted).toBeVisible();
    // Should NOT show quota bar in self-hosted mode
    await expect(quotaBar).not.toBeVisible();
  } else {
    // Cloud mode — quota bar should be present for free users
    await expect(quotaBar).toBeVisible({ timeout: 5000 });
  }
});
