/**
 * Shared helpers for Playwright UI tests.
 * Provides user registration via API and authenticated page navigation.
 */
import { type Page } from '@playwright/test';

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
  const suffix = Math.random().toString(36).slice(2, 10);
  return `pw-${Date.now()}-${process.pid}-${++counter}-${suffix}@test.botmem.xyz`;
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
  const res = await fetch(`${API_BASE}/user-auth/complete-onboarding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Complete onboarding failed: ${res.status}`);
}

/** Seed demo data for a user via API. */
export async function seedDemoData(user: TestUser): Promise<void> {
  const res = await fetch(`${API_BASE}/demo/seed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Demo seed failed: ${res.status} ${await res.text()}`);
}

/** Register, unlock, onboard, and seed a user for UI tests that need data. */
export async function createSeededUser(): Promise<TestUser> {
  const user = await registerUser();
  await submitRecoveryKey(user);
  await completeOnboarding(user);
  await seedDemoData(user);
  return user;
}

function authStorageFor(user: TestUser, onboarded: boolean, accessToken = user.accessToken) {
  return {
    state: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        onboarded,
      },
      accessToken,
      isLoading: false,
      error: null,
      recoveryKey: null,
      needsRecoveryKey: false,
    },
    version: 2,
  };
}

async function browserLogin(
  page: Page,
  user: TestUser,
): Promise<{ accessToken: string; user: TestUser }> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  const result = await page.evaluate(
    async ({ email, password }: { email: string; password: string }) => {
      const res = await fetch('/api/user-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return { ok: false as const, status: res.status, body: await res.text() };
      const data = await res.json();
      return { ok: true as const, accessToken: data.accessToken, user: data.user };
    },
    { email: user.email, password: user.password },
  );

  if (!result.ok) {
    throw new Error(`Browser login failed: ${result.status} ${result.body}`);
  }

  return {
    accessToken: result.accessToken,
    user: {
      ...user,
      accessToken: result.accessToken,
      id: result.user.id,
      email: result.user.email,
      name: result.user.name ?? user.name,
    },
  };
}

/**
 * Inject auth state into the browser context so the app treats the user as logged in.
 * This sets the Zustand persisted auth store in localStorage.
 */
export async function injectAuth(page: Page, user: TestUser): Promise<void> {
  const login = await browserLogin(page, user);
  await page.evaluate(
    ({ storeState }) => {
      localStorage.setItem('botmem-auth', JSON.stringify(storeState));
    },
    { storeState: authStorageFor(login.user, true, login.accessToken) },
  );
}

/** Inject auth for onboarding tests while keeping the user marked not onboarded. */
export async function injectAuthForOnboarding(page: Page, user: TestUser): Promise<void> {
  const login = await browserLogin(page, user);
  await page.evaluate(
    ({ storeState }) => {
      localStorage.setItem('botmem-auth', JSON.stringify(storeState));
    },
    { storeState: authStorageFor(login.user, false, login.accessToken) },
  );
}

/** Navigate as an authenticated, onboarded user. */
export async function navigateAs(
  page: Page,
  user: TestUser,
  targetPath = '/dashboard',
): Promise<void> {
  await injectAuth(page, user);
  await page.goto(targetPath);
  await page.waitForLoadState('networkidle');
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
