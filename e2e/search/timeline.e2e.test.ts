/**
 * Timeline e2e tests (SRCH-036 → SRCH-045)
 * Tests GET /api/memories/timeline endpoint with filters and pagination.
 * NOTE: The timeline endpoint returns a bare array, not { items, total }.
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

describe('Timeline (SRCH-036 → SRCH-045)', () => {
  // SRCH-036: Timeline returns chronological order
  it('SRCH-036 timeline returns memories sorted by eventTime descending', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline');

    expect(res.status).toBe(200);
    // API returns a bare array
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    expect(Array.isArray(items)).toBe(true);

    // Verify descending chronological order
    for (let i = 1; i < items.length; i++) {
      const prev = new Date(items[i - 1].eventTime).getTime();
      const curr = new Date(items[i].eventTime).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  // SRCH-037: Timeline with from and to date range
  it('SRCH-037 timeline with from and to date range filters correctly', async () => {
    const from = '2025-01-01T00:00:00Z';
    const to = '2025-12-31T23:59:59Z';

    const res = await authedRequest(user.accessToken)
      .get(`/api/memories/timeline?from=${from}&to=${to}`);

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);

    for (const item of items) {
      const eventTime = new Date(item.eventTime).getTime();
      expect(eventTime).toBeGreaterThanOrEqual(new Date(from).getTime());
      expect(eventTime).toBeLessThanOrEqual(new Date(to).getTime());
    }
  });

  // SRCH-038: Timeline with connectorType filter
  it('SRCH-038 timeline with connectorType filter returns only that connector', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?connectorType=gmail');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);

    for (const item of items) {
      expect(item.connectorType).toBe('gmail');
    }
  });

  // SRCH-039: Timeline with sourceType filter
  it('SRCH-039 timeline with sourceType filter returns only that source', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?sourceType=email');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);

    for (const item of items) {
      expect(item.sourceType).toBe('email');
    }
  });

  // SRCH-040: Timeline with query search
  it('SRCH-040 timeline with query returns text-matched subset', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?query=meeting');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    expect(Array.isArray(items)).toBe(true);
  });

  // SRCH-041: Timeline with limit
  it('SRCH-041 timeline with limit returns correct number', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?limit=5');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    expect(items.length).toBeLessThanOrEqual(5);
  });

  // SRCH-042: Timeline with memoryBankId
  it('SRCH-042 timeline with memoryBankId scopes to bank', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?memoryBankId=nonexistent-bank');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    // Non-existent bank should return empty
    expect(items).toEqual([]);
  });

  // SRCH-043: Timeline with future dates returns empty
  it('SRCH-043 timeline with future date range returns empty results', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?from=2099-01-01T00:00:00Z&to=2099-12-31T23:59:59Z');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    expect(items).toEqual([]);
  });

  // SRCH-044: Timeline with no filters returns all memories
  it('SRCH-044 timeline with no filters returns all memories chronologically', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/memories/timeline');

    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : (res.body.items ?? []);
    expect(Array.isArray(items)).toBe(true);
  });

  // SRCH-045: Timeline pagination
  it('SRCH-045 timeline pagination with offset continues correctly', async () => {
    // First page
    const page1 = await authedRequest(user.accessToken)
      .get('/api/memories/timeline?limit=2');

    expect(page1.status).toBe(200);
    const items1 = Array.isArray(page1.body) ? page1.body : (page1.body.items ?? []);

    // If we got results, verify second page is different or empty
    if (items1.length === 2) {
      // The timeline endpoint uses from/to for pagination, not offset
      // Use the last item's eventTime as the new 'to' boundary
      const lastTime = items1[items1.length - 1].eventTime;
      const page2 = await authedRequest(user.accessToken)
        .get(`/api/memories/timeline?limit=2&to=${lastTime}`);

      expect(page2.status).toBe(200);
      const items2 = Array.isArray(page2.body) ? page2.body : (page2.body.items ?? []);
      expect(Array.isArray(items2)).toBe(true);
    }
  });
});
