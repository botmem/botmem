/**
 * Auth helpers for e2e tests.
 * Provides user registration, login, token management, and API key creation.
 */
import supertest from 'supertest';
import { getHttpServer } from './app.js';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string;
  accessToken: string;
  recoveryKey: string;
  refreshCookie?: string;
}

let userCounter = 0;

/**
 * Generate a unique test email for each test.
 */
export function uniqueEmail(): string {
  return `e2e-test-${Date.now()}-${++userCounter}@test.botmem.xyz`;
}

/**
 * Register a new user and return full auth context.
 */
export async function registerUser(
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'TestPass123!';
  const name = overrides.name ?? 'E2E Test User';

  const server = getHttpServer();
  const res = await supertest(server)
    .post('/api/user-auth/register')
    .send({ email, password, name })
    .expect(201);

  const cookies = res.headers['set-cookie'];
  const refreshCookie = Array.isArray(cookies)
    ? cookies.find((c: string) => c.startsWith('refresh_token='))
    : typeof cookies === 'string' && cookies.startsWith('refresh_token=')
      ? cookies
      : undefined;

  return {
    id: res.body.user.id,
    email,
    password,
    name,
    accessToken: res.body.accessToken,
    recoveryKey: res.body.recoveryKey,
    refreshCookie,
  };
}

/**
 * Login an existing user and return tokens.
 * Accepts either (email, password) or ({ email, password }).
 */
export async function loginUser(
  emailOrObj: string | { email: string; password: string },
  password?: string,
): Promise<{ accessToken: string; refreshCookie?: string; body: any }> {
  const email = typeof emailOrObj === 'object' ? emailOrObj.email : emailOrObj;
  const pass = typeof emailOrObj === 'object' ? emailOrObj.password : (password ?? '');
  const server = getHttpServer();
  const res = await supertest(server)
    .post('/api/user-auth/login')
    .send({ email, password: pass });

  const cookies = res.headers['set-cookie'];
  const refreshCookie = Array.isArray(cookies)
    ? cookies.find((c: string) => c.startsWith('refresh_token='))
    : undefined;

  return {
    accessToken: res.body.accessToken,
    refreshCookie,
    body: res.body,
  };
}

/**
 * Create an authenticated supertest agent with Bearer token set.
 */
export function authedRequest(token: string) {
  const server = getHttpServer();
  return {
    get: (url: string) =>
      supertest(server).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      supertest(server).post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) =>
      supertest(server).put(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      supertest(server).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      supertest(server).delete(url).set('Authorization', `Bearer ${token}`),
  };
}

/**
 * Create an API key for the given user and return the raw key.
 */
export async function createApiKey(
  token: string,
  opts: { name?: string; memoryBankIds?: string[] } = {},
): Promise<{ id: string; key: string }> {
  const res = await authedRequest(token)
    .post('/api/api-keys')
    .send({ name: opts.name ?? 'e2e-test-key', ...opts })
    .expect(201);

  return { id: res.body.id, key: res.body.key };
}
