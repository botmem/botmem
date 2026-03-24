/**
 * Shared helpers for Playwright UI tests.
 * Provides user registration via API and authenticated page navigation.
 */
import { type Page, type BrowserContext, expect } from '@playwright/test';

const API_BASE = 'http://localhost:12412/api';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string;
  accessToken: string;
  recoveryKey: string;
}

let counter = 0;

/** Generate a unique email for each test. */
export function uniqueEmail(): string {
  return `pw-${Date.now()}-${++counter}@test.botmem.xyz`;
}

/** Register a user via the API and return auth context. */
export async function registerUser(
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'TestPass123!';
  const name = overrides.name ?? 'PW Test User';

  const res = await fetch(`${API_BASE}/user-auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
  const body = await res.json();

  return {
    id: body.user.id,
    email,
    password,
    name,
    accessToken: body.accessToken,
    recoveryKey: body.recoveryKey,
  };
}

/** Submit recovery key for the given user (to warm up the DEK). */
export async function submitRecoveryKey(user: TestUser): Promise<void> {
  const res = await fetch(`${API_BASE}/user-auth/recovery-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
    },
    body: JSON.stringify({ recoveryKey: user.recoveryKey }),
  });
  if (!res.ok) throw new Error(`Recovery key submit failed: ${res.status}`);
}

/** Complete onboarding for a user via API. */
export async function completeOnboarding(user: TestUser): Promise<void> {
  const res = await fetch(`${API_BASE}/me/onboarding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
    },
    body: JSON.stringify({ onboarded: true }),
  });
  // Some APIs may return 200 or 204 — both are fine
  if (!res.ok && res.status !== 404) {
    // Try PATCH /me as fallback
    const res2 = await fetch(`${API_BASE}/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.accessToken}`,
      },
      body: JSON.stringify({ onboarded: true }),
    });
    if (!res2.ok) throw new Error(`Complete onboarding failed: ${res2.status}`);
  }
}

/**
 * Inject auth state into the browser context so the app treats the user as logged in.
 * This sets the Zustand persisted auth store in localStorage.
 */
export async function injectAuth(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ({ accessToken, userData }) => {
      const storeState = {
        state: {
          user: userData,
          accessToken,
          isLoading: false,
          error: null,
          recoveryKey: null,
          needsRecoveryKey: false,
        },
        version: 0,
      };
      localStorage.setItem('auth-storage', JSON.stringify(storeState));
    },
    {
      accessToken: user.accessToken,
      userData: {
        id: user.id,
        email: user.email,
        name: user.name,
        onboarded: true,
      },
    },
  );
}

/**
 * Set up an authenticated page: register user, submit recovery key, complete onboarding,
 * inject auth into localStorage, and navigate to the target page.
 */
export async function setupAuthenticatedPage(
  page: Page,
  targetPath: string = '/dashboard',
): Promise<TestUser> {
  const user = await registerUser();
  await submitRecoveryKey(user);
  await completeOnboarding(user);
  await injectAuth(page, user);
  await page.goto(targetPath);
  await page.waitForLoadState('networkidle');
  return user;
}

/** Login via the UI form. */
export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /log\s*in|sign\s*in/i }).click();
}

/** Wait for navigation to complete and URL to match pattern. */
export async function waitForURL(page: Page, pattern: string | RegExp): Promise<void> {
  await page.waitForURL(pattern, { timeout: 10000 });
}
