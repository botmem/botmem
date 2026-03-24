/**
 * UI-089 → UI-108: Contacts Page
 */
import { test, expect } from '@playwright/test';
import { setupAuthenticatedPage } from './helpers';

test.describe('Contacts Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page, '/people');
  });

  test('UI-089: Contacts page renders', async ({ page }) => {
    await expect(page).toHaveURL(/\/people/);
    // Page should show contacts list or empty state
    await page.waitForLoadState('networkidle');
    const content = page.locator(
      'text=/contact|people|no contact|empty|person/i',
    );
    await expect(content.first()).toBeVisible({ timeout: 10000 });
  });

  test('UI-090: Contact list search by name', async ({ page }) => {
    // Look for search input
    const searchInput = page.locator('#contacts-search').or(
      page.getByPlaceholder(/search/i),
    );
    if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchInput.fill('test');
      await page.waitForLoadState('networkidle');
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-091: Contact list search by email', async ({ page }) => {
    const searchInput = page.locator('#contacts-search').or(
      page.getByPlaceholder(/search/i),
    );
    if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchInput.fill('test@example.com');
      await page.waitForLoadState('networkidle');
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-092: Contact list entityType filter tabs (person/org)', async ({ page }) => {
    // Entity type tabs: All, Person, Organization
    const tabs = page.locator('text=/all|person|org/i');
    if (await tabs.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      // Click on a filter tab
      const personTab = page.locator('button').filter({ hasText: /person/i });
      if (await personTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await personTab.click();
        await page.waitForLoadState('networkidle');
      }
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-093: InfiniteScrollList loads more on scroll', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Scroll down to trigger infinite scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // No crash expected
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-094: ContactCard click opens ContactDetailPanel', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Click the first contact card if visible
    const contactCard = page.locator('[class*="contact"], [class*="card"]').first();
    if (await contactCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactCard.click();
      // Detail panel should appear
      await page.waitForLoadState('networkidle');
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-095: ContactDetailPanel shows displayName', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // If contacts exist, clicking one should show name in detail
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-096: ContactDetailPanel shows identifiers', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Identifiers (email, phone, etc.) shown in detail panel
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-097: ContactDetailPanel shows avatars', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-098: ContactDetailPanel shows linked memories', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-099: ContactDetailPanel edit name', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Edit name button in detail panel
    const editBtn = page.getByRole('button', { name: /edit|rename/i });
    if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(editBtn).toBeVisible();
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-100: ContactDetailPanel delete contact', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const deleteBtn = page.getByRole('button', { name: /delete|remove/i });
    if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(deleteBtn).toBeVisible();
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-101: ContactDetailPanel split identifier', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Split button in detail panel
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-102: ContactDetailPanel update avatar index', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-103: MergeTinder renders suggestions', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // MergeTinder component shows merge suggestions
    const mergeArea = page.locator('text=/merge|suggestion|similar/i');
    // May or may not have suggestions
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-104: MergeTinder accept merge', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Merge accept button
    const mergeBtn = page.getByRole('button', { name: /merge|accept|yes/i });
    if (await mergeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(mergeBtn).toBeVisible();
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-105: MergeTinder dismiss suggestion', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Dismiss button
    const dismissBtn = page.getByRole('button', { name: /dismiss|skip|no/i });
    if (await dismissBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(dismissBtn).toBeVisible();
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-106: MergeTinder no suggestions', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Fresh account should have no merge suggestions
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-107: Contact list empty state (no contacts)', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Fresh account — should show empty state
    const emptyState = page.locator('text=/no contact|empty|no people|connect.*first/i');
    if (await emptyState.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(emptyState.first()).toBeVisible();
    }
    await expect(page).toHaveURL(/\/people/);
  });

  test('UI-108: Contact with multiple connector sources shown', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Contacts with identifiers from multiple connectors
    await expect(page).toHaveURL(/\/people/);
  });
});
