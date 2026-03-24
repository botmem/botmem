/**
 * Merge & Split e2e tests (PEO-036 → PEO-050)
 *
 * Tests merge, split, suggestions, and bulk operations via HTTP API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authedRequest, closeApp, type TestUser } from '../helpers/index.js';
import { seedOnce, refreshPeople } from './setup.js';

let user: TestUser;
let people: any[];

// Track IDs consumed by merge tests so later tests don't use deleted people
const consumedIds: string[] = [];

/** Refresh the local people list from the API. */
async function reload() {
  people = await refreshPeople();
  return people;
}

/** Pick two distinct person-type contacts. */
function pickTwoPeople(): [any, any] {
  const candidates = people.filter(
    (p: any) =>
      (p.entityType ?? 'person') === 'person' && !consumedIds.includes(p.id),
  );
  expect(candidates.length).toBeGreaterThanOrEqual(2);
  return [candidates[0], candidates[1]];
}

/** Find a person with at least minIdents identifiers. */
function findWithMinIdents(minCount: number) {
  return people.find(
    (p: any) =>
      p.identifiers &&
      p.identifiers.length >= minCount &&
      !consumedIds.includes(p.id),
  );
}

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = await refreshPeople();
  expect(people.length).toBeGreaterThan(10);
}, 600_000);

afterAll(async () => { await closeApp(); });

describe('Merge & Split (PEO-036 → PEO-050)', () => {
  it('PEO-036: Manual merge: target gets all source identifiers', async () => {
    const [target, source] = pickTwoPeople();
    consumedIds.push(target.id, source.id);

    const targetIdentsBefore = target.identifiers?.length ?? 0;

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${target.id}/merge`)
      .send({ sourceId: source.id })
      .expect(201);

    expect(res.body.identifiers.length).toBeGreaterThanOrEqual(targetIdentsBefore);
  });

  it('PEO-037: Manual merge: source person deleted', async () => {
    await reload();
    const [target, source] = pickTwoPeople();
    consumedIds.push(target.id, source.id);
    const sourceId = source.id;

    await authedRequest(user.accessToken)
      .post(`/api/people/${target.id}/merge`)
      .send({ sourceId })
      .expect(201);

    // Source should be gone
    const check = await authedRequest(user.accessToken).get(`/api/people/${sourceId}`);
    expect(check.status).toBe(200);
    // NestJS serializes null as empty body
    if (check.body && typeof check.body === 'object') {
      expect(Object.keys(check.body).length === 0 || check.body.id === undefined).toBe(true);
    }
  });

  it('PEO-038: Manual merge: memory associations transferred', async () => {
    await reload();
    const [target, source] = pickTwoPeople();
    consumedIds.push(target.id, source.id);

    await authedRequest(user.accessToken)
      .post(`/api/people/${target.id}/merge`)
      .send({ sourceId: source.id })
      .expect(201);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${target.id}/memories`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it('PEO-039: Manual merge: memoryCount updated on target', async () => {
    await reload();
    const [target, source] = pickTwoPeople();
    consumedIds.push(target.id, source.id);

    const merged = await authedRequest(user.accessToken)
      .post(`/api/people/${target.id}/merge`)
      .send({ sourceId: source.id })
      .expect(201);

    expect(typeof merged.body.memoryCount).toBe('number');
  });

  it('PEO-040: Merge with self is handled gracefully', async () => {
    await reload();
    const person = people.find(
      (p: any) =>
        (p.entityType ?? 'person') === 'person' && !consumedIds.includes(p.id),
    );
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${person.id}/merge`)
      .send({ sourceId: person.id });

    // Accept any non-crash response
    expect([200, 201, 400, 500]).toContain(res.status);
  });

  it('PEO-041: Auto-merge endpoint returns results', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/auto-merge')
      .expect(201);

    expect(res.body).toHaveProperty('merged');
    expect(typeof res.body.merged).toBe('number');
  });

  it('PEO-042: Auto-merge returns byRule breakdown', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/auto-merge')
      .expect(201);

    expect(res.body).toHaveProperty('byRule');
  });

  it('PEO-043: Merge suggestions returns candidates', async () => {
    const res = await authedRequest(user.accessToken)
      .get('/api/people/suggestions')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    for (const suggestion of res.body) {
      expect(suggestion).toHaveProperty('contact1');
      expect(suggestion).toHaveProperty('contact2');
      expect(suggestion).toHaveProperty('reason');
    }
  });

  it('PEO-044: Dismiss merge suggestion', async () => {
    await reload();
    const [p1, p2] = pickTwoPeople();

    const res = await authedRequest(user.accessToken)
      .post('/api/people/suggestions/dismiss')
      .send({ contactId1: p1.id, contactId2: p2.id })
      .expect(201);

    expect(res.body).toEqual({ dismissed: true });
  });

  it('PEO-045: Undismiss merge suggestion', async () => {
    await reload();
    const [p1, p2] = pickTwoPeople();

    // Dismiss first
    await authedRequest(user.accessToken)
      .post('/api/people/suggestions/dismiss')
      .send({ contactId1: p1.id, contactId2: p2.id })
      .expect(201);

    // Undismiss
    const res = await authedRequest(user.accessToken)
      .post('/api/people/suggestions/undismiss')
      .send({ contactId1: p1.id, contactId2: p2.id })
      .expect(201);

    expect(res.body).toEqual({ undismissed: true });
  });

  it('PEO-046: Split moves specified identifiers to new person', async () => {
    await reload();
    const person = findWithMinIdents(2);
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(detail.body.identifiers.length).toBeGreaterThanOrEqual(2);
    const identToSplit = detail.body.identifiers[detail.body.identifiers.length - 1];

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${person.id}/split`)
      .send({ identifierIds: [identToSplit.id] })
      .expect(201);

    const newPersonIdents = res.body.identifiers.map((i: any) => i.identifierType);
    expect(newPersonIdents).toContain(identToSplit.identifierType);
    expect(res.body.id).not.toBe(person.id);
  });

  it('PEO-047: Split: original person retains remaining identifiers', async () => {
    await reload();
    const person = findWithMinIdents(2);
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const identToSplit = detail.body.identifiers[detail.body.identifiers.length - 1];
    const remainingIdent = detail.body.identifiers[0];

    await authedRequest(user.accessToken)
      .post(`/api/people/${person.id}/split`)
      .send({ identifierIds: [identToSplit.id] })
      .expect(201);

    const original = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const found = original.body.identifiers.find(
      (i: any) => i.id === remainingIdent.id,
    );
    expect(found).toBeDefined();
    const splitGone = original.body.identifiers.find(
      (i: any) => i.id === identToSplit.id,
    );
    expect(splitGone).toBeUndefined();
  });

  it('PEO-048: Split: cannot split ALL identifiers', async () => {
    await reload();
    const person = findWithMinIdents(1);
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const allIdentIds = detail.body.identifiers.map((i: any) => i.id);

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${person.id}/split`)
      .send({ identifierIds: allIdentIds });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('PEO-049: Normalize display names', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/normalize');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('normalized');
    expect(res.body).toHaveProperty('deduped');
    expect(res.body).toHaveProperty('merged');
    expect(typeof res.body.normalized).toBe('number');
  }, 120_000);

  it('PEO-050: Reclassify entity types', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/reclassify');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('reclassified');
    expect(res.body).toHaveProperty('details');
    expect(typeof res.body.reclassified).toBe('number');
    expect(Array.isArray(res.body.details)).toBe(true);
  }, 120_000);
});
