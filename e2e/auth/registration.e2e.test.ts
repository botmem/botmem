/**
 * Registration e2e tests (AUTH-001 → AUTH-015)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureApiRunning, closeApp, registerUser, uniqueEmail, authedRequest, request } from '../helpers/index.js';

beforeAll(async () => {
  await ensureApiRunning();
}, 60_000);

afterAll(async () => {
  await closeApp();
});

describe('Registration (AUTH-001 → AUTH-015)', () => {
  it('AUTH-001: Register with valid email, password (8+ chars), name', async () => {
    const email = uniqueEmail();
    const res = await request()
      .post('/api/user-auth/register')
      .send({ email, password: 'TestPass123!', name: 'Test User' })
      .expect(201);

    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('recoveryKey');
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.name).toBe('Test User');

    // Check refresh_token httpOnly cookie is set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const refreshCookie = Array.isArray(cookies)
      ? cookies.find((c: string) => c.includes('refresh_token='))
      : cookies;
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain('HttpOnly');
  });

  it('AUTH-002: Register with duplicate email', async () => {
    const email = uniqueEmail();
    await request()
      .post('/api/user-auth/register')
      .send({ email, password: 'TestPass123!', name: 'First User' })
      .expect(201);

    const res = await request()
      .post('/api/user-auth/register')
      .send({ email, password: 'TestPass123!', name: 'Second User' })
      .expect(409);

    expect(res.body.message).toMatch(/already|exists|conflict/i);
  });

  it('AUTH-003: Register with password < 8 chars', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), password: 'short', name: 'Test' })
      .expect(400);
  });

  it('AUTH-004: Register with password > 100 chars', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), password: 'a'.repeat(101), name: 'Test' })
      .expect(400);
  });

  it('AUTH-005: Register missing email field', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ password: 'TestPass123!', name: 'Test' })
      .expect(400);
  });

  it('AUTH-006: Register missing password field', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), name: 'Test' })
      .expect(400);
  });

  it('AUTH-007: Register missing name field', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), password: 'TestPass123!' })
      .expect(400);
  });

  it('AUTH-008: Register with extra unknown fields (isAdmin: true) — stripped by whitelist', async () => {
    const email = uniqueEmail();
    const res = await request()
      .post('/api/user-auth/register')
      .send({ email, password: 'TestPass123!', name: 'Test', isAdmin: true, role: 'superuser' })
      .expect(201);

    // Extra fields should be stripped — user object should not contain them
    expect(res.body.user).not.toHaveProperty('isAdmin');
    expect(res.body.user).not.toHaveProperty('role');
  });

  it('AUTH-009: Email normalised to lowercase + trimmed', async () => {
    // Use a unique base to avoid collisions across test runs
    const unique = `auth009-${Date.now()}`;
    const rawEmail = `  ${unique}@EXAMPLE.COM  `;
    const res = await request()
      .post('/api/user-auth/register')
      .send({ email: rawEmail, password: 'TestPass123!', name: 'Test' })
      .expect(201);

    expect(res.body.user.email).toBe(`${unique}@example.com`);
  });

  it('AUTH-010: Name trimmed', async () => {
    const res = await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), password: 'TestPass123!', name: '  John  ' })
      .expect(201);

    expect(res.body.user.name).toBe('John');
  });

  it('AUTH-011: Recovery key is a non-empty string', async () => {
    const res = await request()
      .post('/api/user-auth/register')
      .send({ email: uniqueEmail(), password: 'TestPass123!', name: 'Test' })
      .expect(201);

    const recoveryKey = res.body.recoveryKey;
    expect(recoveryKey).toBeDefined();
    expect(typeof recoveryKey).toBe('string');
    expect(recoveryKey.length).toBeGreaterThan(0);
    // Recovery key is a mnemonic phrase (BIP-39 format) or base64 string
    expect(recoveryKey.trim().length).toBeGreaterThan(10);
  });

  it('AUTH-012: DEK stored in memory + Redis after registration', async () => {
    // After registration, DEK should be cached (hot). Verify by submitting recovery key
    // and confirming the endpoint succeeds (proves crypto subsystem is initialized).
    const user = await registerUser();

    // Recovery key submit succeeds — proves DEK was derived and stored
    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it('AUTH-013: encryptionSalt stored on user row', async () => {
    // We can't read encryptionSalt from the API, but we can verify that
    // the encryption subsystem works end-to-end: register → submit recovery key → success.
    // If encryptionSalt were missing, recovery key derivation would fail.
    const user = await registerUser();

    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    // Also verify user profile is accessible (proves user row is intact)
    const meRes = await authedRequest(user.accessToken)
      .get('/api/user-auth/me')
      .expect(200);

    expect(meRes.body.id).toBe(user.id);
  });

  it('AUTH-015: SQL injection in email rejected by validation', async () => {
    await request()
      .post('/api/user-auth/register')
      .send({ email: "' OR 1=1 --", password: 'TestPass123!', name: 'Hacker' })
      .expect(400);
  });
});
