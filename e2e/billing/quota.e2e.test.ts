import { describe, it, expect, beforeAll } from 'vitest';
import { ensureApiRunning, closeApp, registerUser, authedRequest } from '../helpers/index.js';

describe('Memory Quota', () => {
  let user: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    await ensureApiRunning();
    user = await registerUser();
  }, 60_000);

  afterAll(async () => {
    await closeApp();
  });

  describe('GET /billing/quota', () => {
    it('QUOTA-001: returns quota info for authenticated user', async () => {
      const res = await authedRequest(user.accessToken).get('/api/billing/quota').expect(200);

      expect(res.body).toHaveProperty('quota');
      expect(res.body).toHaveProperty('unlimited');
      expect(res.body.quota).toHaveProperty('used');
      expect(res.body.quota).toHaveProperty('limit');
      expect(res.body.quota).toHaveProperty('remaining');
      expect(typeof res.body.quota.used).toBe('number');
    });

    it('QUOTA-002: new user has zero usage', async () => {
      const freshUser = await registerUser();
      const res = await authedRequest(freshUser.accessToken).get('/api/billing/quota').expect(200);

      expect(res.body.quota.used).toBe(0);
    });

    it('QUOTA-003: unauthenticated request is rejected', async () => {
      const { getHttpServer } = await import('../helpers/app.js');
      const supertest = (await import('supertest')).default;
      await supertest(getHttpServer()).get('/api/billing/quota').expect(401);
    });
  });

  describe('GET /billing/info', () => {
    it('QUOTA-004: billing info includes quota field', async () => {
      const res = await authedRequest(user.accessToken).get('/api/billing/info').expect(200);

      // In self-hosted mode billing is disabled, so quota may not be present
      // In cloud mode, quota should be included
      if (res.body.enabled) {
        expect(res.body).toHaveProperty('quota');
        expect(res.body.quota).toHaveProperty('used');
        expect(res.body.quota).toHaveProperty('limit');
        expect(res.body.quota).toHaveProperty('remaining');
      }
    });
  });
});
