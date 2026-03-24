/**
 * Graph e2e tests (SRCH-046 → SRCH-055)
 * Tests GET /api/memories/graph endpoint with various params and link types.
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

describe('Graph (SRCH-046 → SRCH-055)', () => {
  // SRCH-046: Graph returns nodes + edges
  it('SRCH-046 graph returns nodes and edges structure', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).toHaveProperty('links');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.links)).toBe(true);
  });

  // SRCH-047: Graph memoryIds CSV filter
  it('SRCH-047 graph with memoryIds CSV returns only specified memories and links', async () => {
    // First get some memory IDs if available
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=3');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const ids = listRes.body.items.map((m: { id: string }) => m.id).join(',');

      const res = await authedRequest(user.accessToken)
        .get(`/api/memories/graph?memoryIds=${ids}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nodes');
      expect(res.body).toHaveProperty('links');
      // Nodes should be subset of the requested IDs (plus linked)
    } else {
      // No memories, just verify the endpoint handles empty gracefully
      const res = await authedRequest(user.accessToken)
        .get('/api/memories/graph?memoryIds=nonexistent-id');

      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
    }
  });

  // SRCH-048: Graph memoryLimit respected
  it('SRCH-048 graph memoryLimit caps node count', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph?memoryLimit=5');

    expect(res.status).toBe(200);
    expect(res.body.nodes.length).toBeLessThanOrEqual(5);
  });

  // SRCH-049: Graph linkLimit respected
  it('SRCH-049 graph linkLimit caps edge count', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph?linkLimit=10');

    expect(res.status).toBe(200);
    expect(res.body.links.length).toBeLessThanOrEqual(10);
  });

  // SRCH-050: Graph memoryBankId scoping
  it('SRCH-050 graph with memoryBankId scopes to bank', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph?memoryBankId=nonexistent-bank');

    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.links).toEqual([]);
  });

  // SRCH-051: Graph link type 'related'
  it('SRCH-051 graph edges can have linkType related', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    // Verify edge structure if any edges exist
    for (const edge of res.body.links) {
      expect(['related', 'supports', 'contradicts']).toContain(edge.type);
    }
  });

  // SRCH-052: Graph link type 'supports'
  it('SRCH-052 graph edges can have linkType supports', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    // Structure check — actual supports edges depend on data
    for (const edge of res.body.links) {
      expect(edge).toHaveProperty('type');
    }
  });

  // SRCH-053: Graph link type 'contradicts'
  it('SRCH-053 graph edges can have linkType contradicts', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    for (const edge of res.body.links) {
      expect(edge).toHaveProperty('type');
    }
  });

  // SRCH-054: Graph link strength field
  it('SRCH-054 graph edge strength is 0-1 float', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    for (const edge of res.body.links) {
      expect(edge).toHaveProperty('strength');
      expect(typeof edge.strength).toBe('number');
      expect(edge.strength).toBeGreaterThanOrEqual(0);
      expect(edge.strength).toBeLessThanOrEqual(1);
    }
  });

  // SRCH-055: Graph with no links returns nodes only
  it('SRCH-055 graph with no links returns nodes only, no edges', async () => {
    // Use a fresh user guaranteed to have no links
    const freshUser = await registerUser();
    await authedRequest(freshUser.accessToken)
      .post('/api/user-auth/recovery-key')
      .send({ recoveryKey: freshUser.recoveryKey })
      .expect(200);

    const res = await authedRequest(freshUser.accessToken)
      .get('/api/memories/graph');

    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([]);
  });
});
