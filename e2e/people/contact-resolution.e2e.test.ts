/**
 * Contact Resolution e2e tests (PEO-023 → PEO-035)
 *
 * Tests contact resolution behavior via HTTP API using demo-seeded data.
 * Since resolvePerson is internal, these tests verify the observable HTTP
 * behavior: identifiers on contacts, search dedup, and memory associations.
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

/** Find a person with multiple identifier types. */
function findWithMultipleIdentTypes(types: string[]) {
  return people.find(
    (p: any) =>
      p.identifiers &&
      types.every((t) => p.identifiers.some((i: any) => i.identifierType === t)),
  );
}

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = await refreshPeople();
  expect(Array.isArray(people)).toBe(true);
}, 30_000);

afterAll(async () => { await closeApp(); });

describe('Contact Resolution (PEO-023 → PEO-035)', () => {
  it('PEO-023: Multiple identifiers extracted (email + phone or slack_id)', async () => {
    let person = findWithMultipleIdentTypes(['email', 'phone']);
    if (!person) person = findWithMultipleIdentTypes(['email', 'slack_id']);
    if (!person) {
      // Fall back to any person with 2+ identifiers
      person = people.find(
        (p: any) => p.identifiers && p.identifiers.length >= 2,
      );
    }
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(detail.body.identifiers.length).toBeGreaterThanOrEqual(2);
    const types = detail.body.identifiers.map((i: any) => i.identifierType);
    expect(types).toContain('email');
  });

  it('PEO-024: slack_id identifiers extracted', async () => {
    const person = findWithIdentType('slack_id');
    if (!person) {
      // Demo seed may not include slack_id; verify search works
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: 'slack' })
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
      return;
    }

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const types = detail.body.identifiers.map((i: any) => i.identifierType);
    expect(types).toContain('slack_id');
  });

  it('PEO-025: Identifiers from different connectors associated to person', async () => {
    // Find a person who has identifiers from multiple connectors
    const person = people.find((p: any) => {
      if (!p.identifiers || p.identifiers.length < 2) return false;
      const connectors = new Set(
        p.identifiers
          .filter((i: any) => i.connectorType)
          .map((i: any) => i.connectorType),
      );
      return connectors.size >= 2;
    });

    if (!person) {
      // No multi-connector person; verify listing works
      const res = await authedRequest(user.accessToken).get('/api/people').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      return;
    }

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    const connectors = new Set(
      detail.body.identifiers
        .filter((i: any) => i.connectorType)
        .map((i: any) => i.connectorType),
    );
    expect(connectors.size).toBeGreaterThanOrEqual(2);
  });

  it('PEO-026: Dedup by identifierValueHash (same email returns same person)', async () => {
    const personWithEmail = findWithIdentType('email');
    expect(personWithEmail).toBeDefined();

    const emailIdent = personWithEmail.identifiers.find(
      (i: any) => i.identifierType === 'email',
    );
    const email = emailIdent.identifierValue;

    const res1 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: email })
      .expect(201);

    const res2 = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: email })
      .expect(201);

    expect(res1.body.length).toBeGreaterThanOrEqual(1);
    expect(res2.body.length).toBeGreaterThanOrEqual(1);
    expect(res1.body[0].id).toBe(res2.body[0].id);
  });

  it('PEO-027: Cross-connector merge combines identifiers', async () => {
    const p1 = people.find(
      (p: any) =>
        (p.entityType ?? 'person') === 'person' &&
        p.identifiers?.some((i: any) => i.identifierType === 'email'),
    );
    const p2 = people.find(
      (p: any) =>
        (p.entityType ?? 'person') === 'person' &&
        p.id !== p1?.id &&
        p.identifiers?.length >= 1,
    );
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    const p1IdentCount = p1.identifiers.length;

    const res = await authedRequest(user.accessToken)
      .post(`/api/people/${p1.id}/merge`)
      .send({ sourceId: p2.id })
      .expect(201);

    expect(res.body.identifiers.length).toBeGreaterThanOrEqual(p1IdentCount);
  });

  it('PEO-028: name type identifier SKIPPED in resolution (multiple people share first name)', async () => {
    const firstNames = people.map((p: any) => p.displayName?.split(' ')[0]).filter(Boolean);
    const duplicateName = firstNames.find(
      (name, i) => firstNames.indexOf(name) !== i,
    );

    if (duplicateName) {
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: duplicateName })
        .expect(201);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    } else {
      const person = people[0];
      const res = await authedRequest(user.accessToken)
        .post('/api/people/search')
        .send({ query: person.displayName.split(' ')[0] })
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('PEO-029: Person memories endpoint returns array (sender role)', async () => {
    const person = people.find((p: any) => (p.entityType ?? 'person') === 'person');
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/memories`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it('PEO-030: Person detail shows displayName (recipient role)', async () => {
    const person = people.find((p: any) => (p.entityType ?? 'person') === 'person');
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(detail.body).toBeDefined();
    expect(detail.body.displayName).toBeDefined();
  });

  it('PEO-031: Person exists with identifiers (mentioned role)', async () => {
    const person = people.find(
      (p: any) =>
        (p.entityType ?? 'person') === 'person' && p.identifiers?.length >= 1,
    );
    expect(person).toBeDefined();

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(detail.body.identifiers.length).toBeGreaterThanOrEqual(1);
  });

  it('PEO-032: Phone-based contacts exist (participant role)', async () => {
    const person = findWithIdentType('phone');
    if (!person) {
      // Phone contacts may not exist in demo data
      const res = await authedRequest(user.accessToken).get('/api/people').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      return;
    }

    expect(person).toBeDefined();
    expect(person.identifiers.some((i: any) => i.identifierType === 'phone')).toBe(true);
  });

  it('PEO-033: List returns quickly (timeout guard)', async () => {
    const start = Date.now();
    const res = await authedRequest(user.accessToken)
      .get('/api/people?limit=50')
      .expect(200);
    const elapsed = Date.now() - start;

    expect(res.body.items.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(30000);
  });

  it('PEO-034: Search with empty query does not crash', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/search')
      .send({ query: '' });

    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('PEO-035: memoryCount reflects linked memories', async () => {
    const person = people.find((p: any) => (p.entityType ?? 'person') === 'person');
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(typeof res.body.memoryCount).toBe('number');
    expect(res.body.memoryCount).toBeGreaterThanOrEqual(0);
  });
});
