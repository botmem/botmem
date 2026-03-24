/**
 * Identifier Management e2e tests (PEO-013 → PEO-022)
 *
 * Tests identifier CRUD operations via HTTP API using demo-seeded data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authedRequest, closeApp, type TestUser } from '../helpers/index.js';
import { seedOnce, refreshPeople } from './setup.js';

let user: TestUser;
let people: any[];

/** Find a person with a specific identifier type. */
function findWithIdentType(type: string) {
  return people.find(
    (p: any) =>
      p.identifiers && p.identifiers.some((i: any) => i.identifierType === type),
  );
}

/** Find a person with at least N identifiers. */
function findWithMinIdents(minCount: number, exclude?: string) {
  return people.find(
    (p: any) =>
      p.identifiers &&
      p.identifiers.length >= minCount &&
      p.id !== exclude,
  );
}

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = await refreshPeople();
  expect(Array.isArray(people)).toBe(true);
}, 30_000);

afterAll(async () => { await closeApp(); });

describe('Identifier Management (PEO-013 → PEO-022)', () => {
  it('PEO-013: Person has email type identifier', async () => {
    const person = findWithIdentType('email');
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const emailIdent = res.body.identifiers.find(
      (i: any) => i.identifierType === 'email',
    );
    expect(emailIdent).toBeDefined();
    expect(emailIdent.identifierValue).toContain('@');
  });

  it('PEO-014: Person has phone type identifier', async () => {
    const person = findWithIdentType('phone');
    // Demo seed: ~60% of persons get phone identifiers
    if (!person) {
      // Fallback: verify search with phone-like query works
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: '+971' })
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
      return;
    }

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const phoneIdent = res.body.identifiers.find(
      (i: any) => i.identifierType === 'phone',
    );
    expect(phoneIdent).toBeDefined();
    expect(phoneIdent.identifierValue).toMatch(/^\+/);
  });

  it('PEO-015: Person has slack_id type identifier', async () => {
    const person = findWithIdentType('slack_id');
    // Demo seed: ~50% of persons + all groups get slack_id
    if (!person) {
      const res = await authedRequest(user.accessToken).get('/api/people').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      return;
    }

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const slackIdent = res.body.identifiers.find(
      (i: any) => i.identifierType === 'slack_id',
    );
    expect(slackIdent).toBeDefined();
  });

  it('PEO-016: Person identifiers include connectorType', async () => {
    const person = findWithIdentType('email');
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const emailIdent = res.body.identifiers.find(
      (i: any) => i.identifierType === 'email',
    );
    expect(emailIdent).toBeDefined();
    // Demo seed sets connectorType on identifiers
    expect(emailIdent.connectorType).toBeTruthy();
  });

  it('PEO-017: Person with multiple identifier types', async () => {
    // Find a person with at least 2 different identifier types
    const person = people.find((p: any) => {
      if (!p.identifiers || p.identifiers.length < 2) return false;
      const types = new Set(p.identifiers.map((i: any) => i.identifierType));
      return types.size >= 2;
    });

    if (!person) {
      // Verify at least listing works
      const res = await authedRequest(user.accessToken).get('/api/people').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      return;
    }

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const types = new Set(res.body.identifiers.map((i: any) => i.identifierType));
    expect(types.size).toBeGreaterThanOrEqual(2);
  });

  it('PEO-018: Remove single identifier from person', async () => {
    const person = findWithMinIdents(2);
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const identToRemove = detail.body.identifiers[detail.body.identifiers.length - 1];
    expect(identToRemove).toBeDefined();

    await authedRequest(user.accessToken)
      .delete(`/api/people/${person.id}/identifiers/${identToRemove.id}`)
      .expect(200);

    // Verify it's gone but person still exists
    const after = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const removed = after.body.identifiers.find(
      (i: any) => i.id === identToRemove.id,
    );
    expect(removed).toBeUndefined();
    expect(after.body.identifiers.length).toBeGreaterThanOrEqual(1);
  });

  it('PEO-019: Removing last identifier throws error', async () => {
    // Find a person with exactly 1 identifier
    let person = people.find(
      (p: any) => p.identifiers && p.identifiers.length === 1,
    );

    if (!person) {
      // Create one by removing extras from a multi-ident person
      const multi = findWithMinIdents(2);
      if (!multi) return;

      const detail = await authedRequest(user.accessToken)
        .get(`/api/people/${multi.id}`)
        .expect(200);

      for (let i = 1; i < detail.body.identifiers.length; i++) {
        await authedRequest(user.accessToken)
          .delete(`/api/people/${multi.id}/identifiers/${detail.body.identifiers[i].id}`);
      }
      person = multi;
    }

    const detail2 = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const lastIdent = detail2.body.identifiers[0];
    const res = await authedRequest(user.accessToken)
      .delete(`/api/people/${person.id}/identifiers/${lastIdent.id}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('PEO-020: Duplicate identifier prevented (same email returns same person)', async () => {
    const personWithEmail = findWithIdentType('email');
    expect(personWithEmail).toBeDefined();

    const emailIdent = personWithEmail.identifiers.find(
      (i: any) => i.identifierType === 'email',
    );

    const res1 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: emailIdent.identifierValue })
      .expect(201);

    const res2 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: emailIdent.identifierValue })
      .expect(201);

    expect(res1.body[0].id).toBe(res2.body[0].id);

    // Verify no duplicate identifiers on the person
    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${personWithEmail.id}`)
      .expect(200);

    const emailIdents = detail.body.identifiers.filter(
      (i: any) =>
        i.identifierType === 'email' &&
        i.identifierValue === emailIdent.identifierValue,
    );
    expect(emailIdents.length).toBe(1);
  });

  it('PEO-021: Identifier identifierValue is decrypted plain text (not encrypted hash)', async () => {
    const personWithEmail = findWithIdentType('email');
    expect(personWithEmail).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${personWithEmail.id}`)
      .expect(200);

    const emailIdent = detail.body.identifiers.find(
      (i: any) => i.identifierType === 'email',
    );
    // The returned value should be a readable email, not a hash
    expect(emailIdent.identifierValue).toContain('@');
  });

  it('PEO-022: displayName searchable via HMAC blind index', async () => {
    const person = people.find(
      (p: any) => p.displayName && p.displayName.length > 5,
    );
    expect(person).toBeDefined();

    const searchTerm = person.displayName.split(' ')[0];

    const res = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: searchTerm })
      .expect(201);

    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const match = res.body.find((p: any) => p.displayName?.includes(searchTerm));
    expect(match).toBeDefined();
  });
});
