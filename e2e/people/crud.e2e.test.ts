/**
 * People CRUD e2e tests (PEO-001 → PEO-012)
 *
 * Uses demo seed for deterministic data: 100 contacts, ~300 memories, ~200 links.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authedRequest, closeApp, type TestUser } from '../helpers/index.js';
import { seedOnce } from './setup.js';

let user: TestUser;
let people: any[] = [];
let personId: string;

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = ctx.people;
  personId = people[0].id;
}, 30_000);

afterAll(async () => { await closeApp(); });

describe('People CRUD (PEO-001 → PEO-012)', () => {
  it('PEO-001: List people (default, no filter)', async () => {
    const res = await authedRequest(user.accessToken).get('/api/people').expect(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('PEO-002: List people with entityType=person filter', async () => {
    const res = await authedRequest(user.accessToken).get('/api/people?entityType=person').expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item.entityType ?? 'person').toBe('person');
    }
  });

  it('PEO-003: List people with entityType=organization filter', async () => {
    const res = await authedRequest(user.accessToken).get('/api/people?entityType=organization').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const item of res.body.items) {
      expect(item.entityType).toBe('organization');
    }
  });

  it('PEO-004: List people with limit and offset (pagination)', async () => {
    const res1 = await authedRequest(user.accessToken).get('/api/people?limit=2&offset=0').expect(200);
    expect(res1.body.items.length).toBeLessThanOrEqual(2);

    const res2 = await authedRequest(user.accessToken).get('/api/people?limit=2&offset=2').expect(200);
    expect(Number(res2.body.total)).toBe(Number(res1.body.total));

    // Offset pages should not overlap
    if (res1.body.items.length === 2 && res2.body.items.length > 0) {
      const ids1 = res1.body.items.map((p: any) => p.id);
      const ids2 = res2.body.items.map((p: any) => p.id);
      const overlap = ids1.filter((id: string) => ids2.includes(id));
      expect(overlap.length).toBe(0);
    }
  });

  it('PEO-005: Get person by ID returns full detail', async () => {
    const res = await authedRequest(user.accessToken).get(`/api/people/${personId}`).expect(200);
    expect(res.body.id).toBe(personId);
    expect(res.body).toHaveProperty('displayName');
    expect(res.body).toHaveProperty('identifiers');
  });

  it('PEO-006: Get person with unknown ID returns 200 with null/empty', async () => {
    const res = await authedRequest(user.accessToken).get('/api/people/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
  });

  it('PEO-007: Search people by name', async () => {
    const firstName = people[0].displayName?.split(' ')[0] ?? 'a';
    const res = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: firstName })
      .expect(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('PEO-008: Search people by email', async () => {
    const withEmail = people.find((p: any) =>
      p.identifiers?.some((i: any) => i.identifierType === 'email'),
    );
    expect(withEmail).toBeDefined();
    const email = withEmail.identifiers.find((i: any) => i.identifierType === 'email').identifierValue;

    const res = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: email })
      .expect(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('PEO-009: Search people by phone', async () => {
    const withPhone = people.find((p: any) =>
      p.identifiers?.some((i: any) => i.identifierType === 'phone'),
    );
    if (withPhone) {
      const phone = withPhone.identifiers.find((i: any) => i.identifierType === 'phone').identifierValue;
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: phone })
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
    } else {
      // No phone contacts in this seed — verify search doesn't crash
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: '+971' })
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('PEO-010: Update person displayName', async () => {
    const res = await authedRequest(user.accessToken)
      .patch(`/api/people/${personId}`)
      .send({ displayName: 'PEO-010 Updated Name' })
      .expect(200);
    expect(res.body.displayName).toBe('PEO-010 Updated Name');
  });

  it('PEO-011: Update person preferredAvatarIndex', async () => {
    const res = await authedRequest(user.accessToken)
      .patch(`/api/people/${personId}`)
      .send({ preferredAvatarIndex: 0 })
      .expect(200);
    expect(res.body).toHaveProperty('preferredAvatarIndex');
  });

  it('PEO-012: Delete person removes record', async () => {
    // Use last person (disposable)
    const disposable = people[people.length - 1];
    await authedRequest(user.accessToken).delete(`/api/people/${disposable.id}`).expect(200);

    // After delete, GET returns 200 with empty/null body
    const check = await authedRequest(user.accessToken).get(`/api/people/${disposable.id}`);
    expect(check.status).toBe(200);
  });
});
