/**
 * Recovery Key e2e tests (AUTH-048 → AUTH-058)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureApiRunning, closeApp, registerUser, authedRequest, request } from '../helpers/index.js';

beforeAll(async () => {
  await ensureApiRunning();
}, 60_000);

afterAll(async () => {
  await closeApp();
});

describe('Recovery Key (AUTH-048 → AUTH-058)', () => {
  it('AUTH-048: Submit correct recovery key (base64 format)', async () => {
    const user = await registerUser();

    // Submit recovery key via HTTP — proves DEK derivation and caching works
    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    // Verify the user can still access protected endpoints (DEK is loaded)
    await authedRequest(user.accessToken)
      .get('/api/user-auth/me')
      .expect(200);
  });

  it('AUTH-049: Submit correct recovery key (idempotent re-submission)', async () => {
    const user = await registerUser();

    // First submission
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Second submission of the same key should also succeed (idempotent)
    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it('AUTH-050: Submit wrong recovery key — 400', async () => {
    const user = await registerUser();

    // Generate a random wrong key
    const wrongKey = Buffer.from(new Uint8Array(32).fill(0xff)).toString('base64');

    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: wrongKey })
      .expect(400);

    expect(res.body.message).toMatch(/invalid recovery key/i);
  });

  it('AUTH-051: Submit empty recovery key — 400', async () => {
    const user = await registerUser();

    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: '' })
      .expect(400);
  });

  it('AUTH-052: Recovery key endpoint requires JWT auth', async () => {
    await request()
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: 'somekey' })
      .expect(401);
  });

  it('AUTH-053: After recovery key submit, DEK is usable', async () => {
    const user = await registerUser();

    // Submit recovery key
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Verify DEK is usable by accessing protected endpoints and searching
    await authedRequest(user.accessToken)
      .get('/api/user-auth/me')
      .expect(200);

    // Search should not throw a DEK-missing error
    const searchRes = await authedRequest(user.accessToken)
      .post('/api/memories/search')
      .send({ query: 'test' });

    expect([200, 201]).toContain(searchRes.status);
  });

  it('AUTH-054: DEK cached after recovery key submit (login returns needsRecoveryKey: false)', async () => {
    const user = await registerUser();

    // Submit recovery key — this caches DEK in both memory + Redis
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Login again — should return needsRecoveryKey: false (DEK is cached)
    const loginRes = await request()
      .post('/api/user-auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(loginRes.body.needsRecoveryKey).toBe(false);
  });

  it('AUTH-055: Recovery key submit is idempotent — can submit multiple times', async () => {
    const user = await registerUser();

    // Submit twice — both should succeed (DEK encrypted in Redis doesn't change)
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // User can still use the API
    await authedRequest(user.accessToken)
      .get('/api/user-auth/me')
      .expect(200);
  });

  it('AUTH-056: DEK persists across logins (recovery key not required again)', async () => {
    const user = await registerUser();

    // Submit recovery key
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Login multiple times — DEK should stay cached (memory + Redis)
    for (let i = 0; i < 3; i++) {
      const res = await request()
        .post('/api/user-auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);

      expect(res.body.needsRecoveryKey).toBe(false);
    }
  });

  it('AUTH-057: Recovery key submit followed by search — DEK works within session', async () => {
    const user = await registerUser();

    // Submit recovery key
    await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: user.recoveryKey })
      .expect(200);

    // Search twice — both should work (proves in-memory DEK persists within process)
    const res1 = await authedRequest(user.accessToken)
      .post('/api/memories/search')
      .send({ query: 'test' });
    expect([200, 201]).toContain(res1.status);

    const res2 = await authedRequest(user.accessToken)
      .post('/api/memories/search')
      .send({ query: 'another test' });
    expect([200, 201]).toContain(res2.status);
  });

  it('AUTH-058: Wrong recovery key does not crash server — returns 400 gracefully', async () => {
    const user = await registerUser();

    const wrongKey = Buffer.from(new Uint8Array(32).fill(0xaa)).toString('base64');

    // Wrong key — should return 400, not 500
    const res = await authedRequest(user.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: wrongKey })
      .expect(400);

    expect(res.body.message).toMatch(/invalid recovery key/i);

    // Server should still be healthy after the failed attempt
    await authedRequest(user.accessToken)
      .get('/api/user-auth/me')
      .expect(200);
  });
});
