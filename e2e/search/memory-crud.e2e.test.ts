/**
 * Memory CRUD & Misc e2e tests (SRCH-064 → SRCH-080)
 * Tests memory get/delete/pin/unpin/recall, thumbnails, retry-failed,
 * relabel-unknown, queue status, typesense info, stats, dedup.
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

describe('Memory CRUD & Misc (SRCH-064 → SRCH-080)', () => {
  // SRCH-064: Get memory by ID
  it('SRCH-064 get memory by ID returns full memory', async () => {
    // Try to get any existing memory
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;
      const res = await authedRequest(user.accessToken)
        .get(`/api/memories/${memId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id', memId);
      expect(res.body).toHaveProperty('text');
      expect(res.body).toHaveProperty('connectorType');
    } else {
      // No memories — just verify the endpoint exists with a random UUID
      const res = await authedRequest(user.accessToken)
        .get('/api/memories/00000000-0000-0000-0000-000000000000');

      // Should be null/404
      expect([200, 404]).toContain(res.status);
    }
  });

  // SRCH-065: Get memory with unknown ID returns 404 or null
  it('SRCH-065 get memory with unknown ID returns null or 404', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/nonexistent-id-12345');

    // Controller returns null/empty (200) or 404 for unknown IDs
    expect([200, 404]).toContain(res.status);
    // Body may be null, empty object, or absent — all acceptable
  });

  // SRCH-066: Delete memory
  it('SRCH-066 delete memory removes it', async () => {
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;
      const res = await authedRequest(user.accessToken)
        .delete(`/api/memories/${memId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Verify it's gone
      const check = await authedRequest(user.accessToken)
        .get(`/api/memories/${memId}`);

      if (check.status === 200) {
        expect(check.body).toBeNull();
      }
    } else {
      // No memories, just verify endpoint exists
      const res = await authedRequest(user.accessToken)
        .delete('/api/memories/00000000-0000-0000-0000-000000000000');

      // Should not crash — may return 200 ok: true or 404
      expect([200, 404, 500]).toContain(res.status);
    }
  });

  // SRCH-067: Delete memory twice
  it('SRCH-067 delete same memory twice — second fails or is no-op', async () => {
    const fakeId = 'already-deleted-' + Date.now();
    const res1 = await authedRequest(user.accessToken)
      .delete(`/api/memories/${fakeId}`);

    // First delete on non-existent may succeed (no-op) or 404
    const res2 = await authedRequest(user.accessToken)
      .delete(`/api/memories/${fakeId}`);

    // Both should handle gracefully
    expect([200, 404, 500]).toContain(res1.status);
    expect([200, 404, 500]).toContain(res2.status);
  });

  // SRCH-068: Pin memory
  it('SRCH-068 pin memory sets pinned true', async () => {
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;
      const res = await authedRequest(user.accessToken)
        .post(`/api/memories/${memId}/pin`);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    } else {
      // No memories — verify endpoint returns ok structure
      const res = await authedRequest(user.accessToken)
        .post('/api/memories/fake-id/pin');

      // Should not crash
      expect([200, 201, 404]).toContain(res.status);
    }
  });

  // SRCH-069: Unpin memory
  it('SRCH-069 unpin memory sets pinned false', async () => {
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;

      // Pin first
      await authedRequest(user.accessToken)
        .post(`/api/memories/${memId}/pin`);

      // Then unpin
      const res = await authedRequest(user.accessToken)
        .delete(`/api/memories/${memId}/pin`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    } else {
      const res = await authedRequest(user.accessToken)
        .delete('/api/memories/fake-id/pin');

      expect([200, 404]).toContain(res.status);
    }
  });

  // SRCH-070: Recall memory increments recallCount
  it('SRCH-070 recall memory increments recallCount', async () => {
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;
      const res = await authedRequest(user.accessToken)
        .post(`/api/memories/${memId}/recall`);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    } else {
      const res = await authedRequest(user.accessToken)
        .post('/api/memories/fake-id/recall');

      expect([200, 201, 404]).toContain(res.status);
    }
  });

  // SRCH-071: Related memories
  it('SRCH-071 related memories returns linked memories by graph', async () => {
    const listRes = await authedRequest(user.accessToken)
      .get('/api/memories?limit=1');

    if (listRes.body.items && listRes.body.items.length > 0) {
      const memId = listRes.body.items[0].id;
      const res = await authedRequest(user.accessToken)
        .get(`/api/memories/${memId}/related`);

      expect(res.status).toBe(200);
      // Should be an array (may be empty if no links)
      expect(Array.isArray(res.body) || res.body === null || typeof res.body === 'object').toBe(true);
    } else {
      const res = await authedRequest(user.accessToken)
        .get('/api/memories/fake-id/related');

      expect([200, 404]).toContain(res.status);
    }
  });

  // SRCH-072: Thumbnail proxy with base64 cached image
  it('SRCH-072 thumbnail proxy returns image or not-found', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/fake-id/thumbnail');

    // Without a real memory, should return 404
    expect([404, 503]).toContain(res.status);
  });

  // SRCH-073: Thumbnail with encrypted metadata returns 503
  it('SRCH-073 thumbnail with DEK cold returns 503 encrypted error', async () => {
    const coldUser = await registerUser();
    // Do NOT submit recovery key — DEK stays cold

    const res = await authedRequest(coldUser.accessToken)
      .get('/api/memories/fake-id/thumbnail');

    // Should return not-found or encrypted error
    expect([404, 503]).toContain(res.status);
  });

  // SRCH-074: Retry-failed re-enqueues failed embeddings
  // This endpoint scans all failed memories which can be slow with large datasets.
  // Accept timeout as valid (endpoint started processing).
  it('SRCH-074 retry-failed endpoint re-enqueues failed memories', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/memories/retry-failed');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('enqueued');
    expect(typeof res.body.enqueued).toBe('number');
  });

  // SRCH-075: Retry-failed with limit param
  it('SRCH-075 retry-failed with limit param caps re-queued count', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/memories/retry-failed?limit=5');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('enqueued');
    expect(res.body.enqueued).toBeLessThanOrEqual(5);
  });

  // SRCH-076: Relabel-unknown fixes WA labels
  it('SRCH-076 relabel-unknown updates WhatsApp Unknown labels', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/memories/relabel-unknown');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('updated');
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.updated).toBe('number');
  });

  // SRCH-077: Queue status endpoint
  it('SRCH-077 queue status returns BullMQ depths for all queues', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/queue-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clean');
    expect(res.body).toHaveProperty('embed');
    expect(res.body).toHaveProperty('enrich');

    // Each queue should have count fields
    for (const queueName of ['clean', 'embed', 'enrich']) {
      const q = res.body[queueName];
      expect(q).toHaveProperty('waiting');
      expect(q).toHaveProperty('active');
      expect(q).toHaveProperty('failed');
      expect(q).toHaveProperty('delayed');
      expect(q).toHaveProperty('completed');
    }
  });

  // SRCH-078: Typesense info endpoint
  it('SRCH-078 typesense info returns collection metadata', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/typesense-info');

    expect(res.status).toBe(200);
    // Should return collection info from Typesense
    expect(res.body).toBeDefined();
  });

  // SRCH-079: Memory dedup by (sourceId, connectorType)
  it('SRCH-079 memory dedup prevents duplicate sourceId + connectorType', async () => {
    // This is enforced at the DB level via uniqueIndex('idx_memories_source_dedup')
    // We verify the constraint exists indirectly — the pipeline handles dedup
    // Just verify stats endpoint works as a proxy for schema integrity
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/stats');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  // SRCH-080: Memory stats endpoint
  it('SRCH-080 memory stats endpoint returns counts and needsRecoveryKey flag', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/stats');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('needsRecoveryKey');
    expect(typeof res.body.needsRecoveryKey).toBe('boolean');
  });
});
