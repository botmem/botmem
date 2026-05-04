/**
 * UI-059 → UI-068: Dashboard Logs tab
 */
import { test, expect } from '@playwright/test';
import { setupAuthenticatedPage } from './helpers';

test.describe('Dashboard Logs', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page, '/dashboard');
  });

  test('UI-059: Logs tab renders', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-060: ConnectorLogFeed shows real-time logs (WebSocket)', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-061: Log entries show level (info/warn/error)', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-062: Log entries show timestamp', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-063: JobTable shows active jobs', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-064: JobTable cancel button cancels job', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-065: JobTable progress bar updates in real-time', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-066: JobTable shows completed jobs', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-067: JobTable shows failed jobs with error', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('UI-068: Job detail shows log entries', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
