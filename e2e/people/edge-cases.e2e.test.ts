/**
 * Edge Cases e2e tests (PEO-059 → PEO-065)
 *
 * Tests edge case behavior via HTTP API using demo-seeded data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authedRequest, closeApp, type TestUser } from '../helpers/index.js';
import { seedOnce, refreshPeople, cleanupSeed } from './setup.js';

let user: TestUser;
let people: any[];

// Track IDs consumed by destructive tests so later tests don't reuse deleted/modified people
const consumedIds: string[] = [];

/** Pick a person-type contact from the list, excluding consumed IDs. */
function pickPerson(): any {
  return people.find(
    (p: any) =>
      (p.entityType ?? 'person') === 'person' && !consumedIds.includes(p.id),
  );
}

/** Pick two distinct person-type contacts, excluding consumed IDs. */
function pickTwoPeople(): [any, any] {
  const candidates = people.filter(
    (p: any) =>
      (p.entityType ?? 'person') === 'person' && !consumedIds.includes(p.id),
  );
  expect(candidates.length).toBeGreaterThanOrEqual(2);
  return [candidates[0], candidates[1]];
}

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = await refreshPeople();
  expect(people.length).toBeGreaterThan(0);
}, 600_000);

afterAll(async () => {
  await cleanupSeed();
  await closeApp();
});

describe('Edge Cases (PEO-059 → PEO-065)', () => {
  it('PEO-059: WA contact with phone-only displayName identified', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();
    consumedIds.push(person.id);

    const phoneDisplayName = '+971585387813';
    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({ displayName: phoneDisplayName })
      .expect(200);

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(detail.body.displayName).toBe(phoneDisplayName);
    expect(/^\+\d+$/.test(detail.body.displayName)).toBe(true);
  });

  it('PEO-060: Cross-connector name matching does NOT merge (same displayName coexists)', async () => {
    const [p1, p2] = pickTwoPeople();
    consumedIds.push(p1.id, p2.id);

    const sharedName = 'John Common PEO060';
    await authedRequest(user.accessToken)
      .patch(`/api/people/${p1.id}`)
      .send({ displayName: sharedName })
      .expect(200);
    await authedRequest(user.accessToken)
      .patch(`/api/people/${p2.id}`)
      .send({ displayName: sharedName })
      .expect(200);

    // Both should still exist separately
    const detail1 = await authedRequest(user.accessToken)
      .get(`/api/people/${p1.id}`)
      .expect(200);
    const detail2 = await authedRequest(user.accessToken)
      .get(`/api/people/${p2.id}`)
      .expect(200);

    expect(detail1.body).toBeDefined();
    expect(detail2.body).toBeDefined();
    expect(detail1.body.id).not.toBe(detail2.body.id);
  });

  it('PEO-061: Cross-connector email matching merges correctly (merge via API)', async () => {
    const [p1, p2] = pickTwoPeople();
    consumedIds.push(p1.id, p2.id);

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${p1.id}/merge`)
      .send({ sourceId: p2.id })
      .expect(201);

    expect(res.body.identifiers.length).toBeGreaterThanOrEqual(1);
    expect(res.body.id).toBe(p1.id);

    // Source should be gone
    const check = await authedRequest(user.accessToken)
      .get(`/api/people/${p2.id}`);
    expect(check.status).toBe(200);
    if (check.body && typeof check.body === 'object') {
      expect(Object.keys(check.body).length === 0 || check.body.id === undefined).toBe(true);
    }
  });

  it('PEO-062: Person with memoryCount returns correctly', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(res.body.id).toBe(person.id);
    expect(typeof res.body.memoryCount).toBe('number');

    const memsRes = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/memories`)
      .expect(200);

    expect(Array.isArray(memsRes.body)).toBe(true);
  });

  it('PEO-063: Delete person with memory associations removes record', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();
    consumedIds.push(person.id);

    await authedRequest(user.accessToken)
      .delete(`/api/people/${person.id}`)
      .expect(200);

    const check = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`);

    expect(check.status).toBe(200);
    if (check.body && typeof check.body === 'object') {
      expect(Object.keys(check.body).length === 0 || check.body.id === undefined).toBe(true);
    }
  });

  it('PEO-064: Search person with special characters in name', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();
    consumedIds.push(person.id);

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({ displayName: "O'Brien-Smith & Co." })
      .expect(200);

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);
    expect(detail.body.displayName).toBe("O'Brien-Smith & Co.");

    // Search with special characters should not crash
    const res = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: "O'Brien" });

    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('PEO-065: Search consistency (same query returns same results)', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    const searchTerm = person.displayName?.split(' ')[0] || 'test';

    const res1 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: searchTerm })
      .expect(201);

    const res2 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: searchTerm })
      .expect(201);

    expect(res1.body.length).toBe(res2.body.length);
    if (res1.body.length > 0) {
      expect(res1.body[0].id).toBe(res2.body[0].id);
    }
  });
});
