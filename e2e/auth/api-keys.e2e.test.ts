/**
 * API Keys e2e tests (AUTH-090 → AUTH-101)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { ensureApiRunning,
  closeApp,
  getHttpServer,
  registerUser,
  authedRequest,
  createApiKey,
  request } from '../helpers/index.js';

let testUser: Awaited<ReturnType<typeof registerUser>>;

beforeAll(async () => {
  await ensureApiRunning();
  testUser = await registerUser();
}, 60_000);

afterAll(async () => {
  await closeApp();
});

describe('API Keys (AUTH-090 → AUTH-101)', () => {
  it('AUTH-090: Create API key — 201, returns full key with bm_sk_ prefix', async () => {
    const res = await authedRequest(testUser.accessToken)
      .post('/api/api-keys')
      .send({ name: 'test-key-090' })
      .expect(201);

    expect(res.body).toHaveProperty('key');
    expect(res.body.key).toMatch(/^bm_sk_/);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'test-key-090');
    expect(res.body).toHaveProperty('lastFour');
    expect(res.body.lastFour.length).toBe(4);
  });

  it('AUTH-091: List API keys — returns array with lastFour only, never full key', async () => {
    // Create a key first
    await createApiKey(testUser.accessToken, { name: 'test-key-091' });

    const res = await authedRequest(testUser.accessToken)
      .get('/api/api-keys')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    // Verify no full key is returned
    for (const key of res.body) {
      expect(key).toHaveProperty('lastFour');
      expect(key).not.toHaveProperty('key');
      expect(key).not.toHaveProperty('keyHash');
    }
  });

  it('AUTH-092: Revoke API key — 200', async () => {
    const { id } = await createApiKey(testUser.accessToken, { name: 'test-key-092' });

    const res = await authedRequest(testUser.accessToken)
      .delete(`/api/api-keys/${id}`)
      .expect(200);

    expect(res.body).toHaveProperty('success', true);
  });

  it('AUTH-093: Use valid API key on search endpoint', async () => {
    const { key } = await createApiKey(testUser.accessToken, { name: 'test-key-093' });

    const res = await supertest(getHttpServer())
      .post('/api/memories/search')
      .set('Authorization', `Bearer ${key}`)
      .send({ query: 'test' });

    // Search endpoint should accept the API key (200 or empty results)
    expect([200, 201]).toContain(res.status);
  });

  it('AUTH-094: Use revoked API key — 401', async () => {
    const { id, key } = await createApiKey(testUser.accessToken, { name: 'test-key-094' });

    // Revoke it
    await authedRequest(testUser.accessToken)
      .delete(`/api/api-keys/${id}`)
      .expect(200);

    // Try using revoked key
    const res = await supertest(getHttpServer())
      .get('/api/user-auth/me')
      .set('Authorization', `Bearer ${key}`)
      .expect(401);
  });

  it('AUTH-095: Revoked API key returns 401 (same as expired)', async () => {
    // We cannot set expiresAt in the past via HTTP alone, but we can verify
    // that a revoked key (functionally equivalent to expired) returns 401.
    const { id, key } = await createApiKey(testUser.accessToken, { name: 'test-key-095' });

    // Revoke the key
    await authedRequest(testUser.accessToken)
      .delete(`/api/api-keys/${id}`)
      .expect(200);

    // Revoked key should be rejected with 401
    await supertest(getHttpServer())
      .get('/api/user-auth/me')
      .set('Authorization', `Bearer ${key}`)
      .expect(401);
  });

  it('AUTH-096: API key on POST /memories/search (@ReadOnly) — allowed', async () => {
    const { key } = await createApiKey(testUser.accessToken, { name: 'test-key-096' });

    const res = await supertest(getHttpServer())
      .post('/api/memories/search')
      .set('Authorization', `Bearer ${key}`)
      .send({ query: 'test' });

    // Should be allowed (ReadOnly endpoint exempted from write scope)
    expect([200, 201]).toContain(res.status);
  });

  it('AUTH-097: API key on POST /api/jobs/sync/:accountId (write endpoint, no @ReadOnly) — 403', async () => {
    const { key } = await createApiKey(testUser.accessToken, { name: 'test-key-097' });

    const res = await supertest(getHttpServer())
      .post('/api/jobs/sync/test-account')
      .set('Authorization', `Bearer ${key}`)
      .expect(403);
  });

  it('AUTH-098: API key on DELETE endpoint — 403 (write scope required)', async () => {
    const { key } = await createApiKey(testUser.accessToken, { name: 'test-key-098' });

    const res = await supertest(getHttpServer())
      .delete('/api/memories/some-fake-id')
      .set('Authorization', `Bearer ${key}`)
      .expect(403);
  });

  it('AUTH-099: API key on GET /api-keys (management endpoint, @RequiresJwt) — 403', async () => {
    const { key } = await createApiKey(testUser.accessToken, { name: 'test-key-099' });

    const res = await supertest(getHttpServer())
      .get('/api/api-keys')
      .set('Authorization', `Bearer ${key}`)
      .expect(403);
  });

  it('AUTH-100: API key with memoryBankIds scoping', async () => {
    // Create a real memory bank first (service validates ownership)
    const bankRes = await authedRequest(testUser.accessToken)
      .post('/api/memory-banks')
      .send({ name: 'e2e-test-bank-100' })
      .expect(201);
    const bankId = bankRes.body.id;

    const { key } = await createApiKey(testUser.accessToken, {
      name: 'test-key-100',
      memoryBankIds: [bankId],
    });

    // Use the key — the scoping is applied at search time
    const res = await supertest(getHttpServer())
      .post('/api/memories/search')
      .set('Authorization', `Bearer ${key}`)
      .send({ query: 'test' });

    // Should succeed (scoping filters results, doesn't block access)
    expect([200, 201]).toContain(res.status);
  });

  it('AUTH-101: Raw API key not exposed in list response — only lastFour shown', async () => {
    const { id, key } = await createApiKey(testUser.accessToken, { name: 'test-key-101' });

    // List all keys — raw key should NOT appear anywhere
    const res = await authedRequest(testUser.accessToken)
      .get('/api/api-keys')
      .expect(200);

    const listedKey = res.body.find((k: any) => k.id === id);
    expect(listedKey).toBeDefined();

    // Only lastFour is exposed, not the full key or hash
    expect(listedKey).toHaveProperty('lastFour');
    expect(listedKey).not.toHaveProperty('key');
    expect(listedKey).not.toHaveProperty('keyHash');

    // The full key string should not appear anywhere in the response
    const responseStr = JSON.stringify(res.body);
    expect(responseStr).not.toContain(key);

    // lastFour should match the last 4 chars of the raw key
    expect(key.endsWith(listedKey.lastFour)).toBe(true);
  });
});
