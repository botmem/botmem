/**
 * Entities e2e tests (SRCH-056 → SRCH-063)
 * Tests GET /api/memories/entities/* endpoints for entity types, search, and graphs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureApiRunning,
  
  closeApp,
  registerUser,
  authedRequest,
  type TestUser,
} from '../helpers/index.js';

let user: TestUser;

beforeAll(async () => {
  await ensureApiRunning();
  user = await registerUser();

  await authedRequest(user.accessToken)
    .post('/api/user-auth/recovery-key')
    .send({ recoveryKey: user.recoveryKey })
    .expect(200);
}, 60_000);

afterAll(async () => {
  await closeApp();
});

describe('Entities (SRCH-056 → SRCH-063)', () => {
  // SRCH-056: List all entity types
  it('SRCH-056 entity types endpoint returns distinct types', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/types');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('types');
    expect(Array.isArray(res.body.types)).toBe(true);
  });

  // SRCH-057: Search entities by query
  it('SRCH-057 search entities by query returns matching entities', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/search?q=test');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entities');
    expect(Array.isArray(res.body.entities)).toBe(true);
    expect(res.body).toHaveProperty('total');
  });

  // SRCH-058: Search entities filtered by type
  it('SRCH-058 search entities filtered by type returns only matching type', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/search?q=test&type=person');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entities');
    // All returned entities should be of the requested type
    for (const entity of res.body.entities) {
      if (entity.type) {
        expect(entity.type).toBe('person');
      }
    }
  });

  // SRCH-059: Entity search with limit
  it('SRCH-059 entity search respects limit param', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/search?q=test&limit=3');

    expect(res.status).toBe(200);
    expect(res.body.entities.length).toBeLessThanOrEqual(3);
  });

  // SRCH-060: Entity neighbourhood graph
  it('SRCH-060 entity graph returns connected memories for entity', async () => {
    const entityValue = encodeURIComponent('test-entity');
    const res = await authedRequest(user.accessToken)
      .get(`/api/memories/entities/${entityValue}/graph`);

    expect(res.status).toBe(200);
    // Should return graph structure (memories connected to entity)
    expect(res.body).toBeDefined();
  });

  // SRCH-061: Entity with special characters
  it('SRCH-061 entity with special characters is handled correctly', async () => {
    const entityValue = encodeURIComponent("O'Brien & Co. (LLC)");
    const res = await authedRequest(user.accessToken)
      .get(`/api/memories/entities/${entityValue}/graph`);

    // Should not crash
    expect([200, 404]).toContain(res.status);
  });

  // SRCH-062: Entity search empty query
  it('SRCH-062 entity search with empty query returns empty or 400', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/search?q=');

    expect(res.status).toBe(200);
    // Empty query returns empty results (per controller: if (!q) return { entities: [], total: 0 })
    expect(res.body.entities).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  // SRCH-063: Entity types from multiple connectors
  it('SRCH-063 entity types are aggregated from multiple connectors', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/entities/types');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.types)).toBe(true);
    // Types should be deduplicated strings
    const types = res.body.types;
    const uniqueTypes = [...new Set(types)];
    expect(types.length).toBe(uniqueTypes.length);
  });
});
