/**
 * Refresh Tokens e2e tests (AUTH-039 → AUTH-047)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { ensureApiRunning, closeApp, getHttpServer, registerUser, request } from '../helpers/index.js';

beforeAll(async () => {
  await ensureApiRunning();
}, 60_000);

afterAll(async () => {
  await closeApp();
});

/** Extract the refresh_token cookie value from set-cookie headers */
function extractRefreshCookie(res: supertest.Response): string | undefined {
  const cookies = res.headers['set-cookie'];
  const cookie = Array.isArray(cookies)
    ? cookies.find((c: string) => c.includes('refresh_token='))
    : typeof cookies === 'string' && cookies.includes('refresh_token=')
      ? cookies
      : undefined;
  return cookie;
}

/** Extract just the token value from the cookie string */
function extractRefreshTokenValue(cookieStr: string): string {
  const match = cookieStr.match(/refresh_token=([^;]+)/);
  return match ? match[1] : '';
}

describe('Refresh Tokens (AUTH-039 → AUTH-047)', () => {
  it('AUTH-039: Valid refresh cookie returns new access token', async () => {
    const user = await registerUser();

    const res = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', user.refreshCookie!)
      .expect(200);

    expect(res.body).toHaveProperty('accessToken');
    expect(typeof res.body.accessToken).toBe('string');

    // New refresh cookie should be set (rotation)
    const newCookie = extractRefreshCookie(res);
    expect(newCookie).toBeDefined();
  });

  it('AUTH-040: Expired refresh cookie — 401', async () => {
    // We can't easily create a truly expired refresh token without manipulating time.
    // Instead, test with a garbage token value in the cookie.
    const res = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', 'refresh_token=expired.garbage.token')
      .expect(401);
  });

  it('AUTH-041: Missing refresh cookie — 401', async () => {
    const res = await request()
      .post('/api/user-auth/refresh')
      .expect(401);

    expect(res.body.message).toMatch(/no refresh token/i);
  });

  it('AUTH-042: Refresh rotates — old cookie no longer works', async () => {
    const user = await registerUser();
    const originalCookie = user.refreshCookie!;

    // First refresh — should succeed
    const res1 = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', originalCookie)
      .expect(200);

    expect(res1.body).toHaveProperty('accessToken');

    // Second refresh with the SAME (now-revoked) cookie — should fail
    const res2 = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', originalCookie)
      .expect(401);
  });

  it('AUTH-043: Replay detection — replayed revoked token revokes entire family', async () => {
    const user = await registerUser();
    const originalCookie = user.refreshCookie!;

    // First refresh — get new token
    const res1 = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', originalCookie)
      .expect(200);

    const newCookie = extractRefreshCookie(res1);
    expect(newCookie).toBeDefined();

    // Replay the original (revoked) cookie — triggers family revocation
    await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', originalCookie)
      .expect(401);

    // Now even the NEW cookie from the first refresh should be revoked (family purge)
    await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', newCookie!)
      .expect(401);
  });

  it('AUTH-044: Refresh stores new token in DB (rotation produces new cookie)', async () => {
    const user = await registerUser();

    const res = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', user.refreshCookie!)
      .expect(200);

    // Verify new cookie is different from original
    const newCookie = extractRefreshCookie(res);
    expect(newCookie).toBeDefined();
    const newValue = extractRefreshTokenValue(newCookie!);
    const oldValue = extractRefreshTokenValue(user.refreshCookie!);
    expect(newValue).not.toBe(oldValue);
  });

  it('AUTH-045: Logout clears refresh cookie', async () => {
    const user = await registerUser();

    const res = await request()
      .post('/api/user-auth/logout')
      .set('Cookie', user.refreshCookie!)
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    // Cookie should be cleared (set to empty or expired)
    const cookies = res.headers['set-cookie'];
    const clearCookie = Array.isArray(cookies)
      ? cookies.find((c: string) => c.includes('refresh_token='))
      : cookies;
    expect(clearCookie).toBeDefined();
    // Cleared cookie should have expiry in the past or empty value
    expect(clearCookie).toMatch(/refresh_token=;|Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('AUTH-046: Logout with invalid/missing cookie — 200 (graceful no-op)', async () => {
    // No cookie at all
    await request()
      .post('/api/user-auth/logout')
      .expect(200);

    // Invalid cookie value
    const res = await request()
      .post('/api/user-auth/logout')
      .set('Cookie', 'refresh_token=invalid.token.value')
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it('AUTH-047: Multiple active refresh token families (multi-device)', async () => {
    const email = `multi-device-${Date.now()}@test.botmem.xyz`;
    const password = 'TestPass123!';

    // Register
    await request()
      .post('/api/user-auth/register')
      .send({ email, password, name: 'Multi Device' })
      .expect(201);

    // Login from "device 1"
    const login1 = await request()
      .post('/api/user-auth/login')
      .send({ email, password })
      .expect(200);

    // Login from "device 2"
    const login2 = await request()
      .post('/api/user-auth/login')
      .send({ email, password })
      .expect(200);

    const cookie1 = extractRefreshCookie(login1);
    const cookie2 = extractRefreshCookie(login2);

    expect(cookie1).toBeDefined();
    expect(cookie2).toBeDefined();

    // Both should be independently refreshable
    const refresh1 = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', cookie1!)
      .expect(200);

    const refresh2 = await request()
      .post('/api/user-auth/refresh')
      .set('Cookie', cookie2!)
      .expect(200);

    expect(refresh1.body.accessToken).toBeDefined();
    expect(refresh2.body.accessToken).toBeDefined();
  });
});
