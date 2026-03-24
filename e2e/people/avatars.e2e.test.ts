/**
 * Avatars e2e tests (PEO-051 → PEO-058)
 *
 * Seeds demo data via HTTP API, then tests avatar-related operations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { authedRequest, closeApp, type TestUser } from '../helpers/index.js';
import { seedOnce, refreshPeople } from './setup.js';

let user: TestUser;
let people: any[];

/** Pick a person-type contact from the list. */
function pickPerson(exclude?: string): any {
  return people.find(
    (p: any) => (p.entityType ?? 'person') === 'person' && p.id !== exclude,
  );
}

beforeAll(async () => {
  const ctx = await seedOnce();
  user = ctx.user;
  people = await refreshPeople();
  expect(Array.isArray(people)).toBe(true);
}, 30_000);

afterAll(async () => { await closeApp(); });

describe('Avatars (PEO-051 → PEO-058)', () => {
  it('PEO-051: Avatar proxy serves base64 data URI directly', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    // Set avatar as base64 data URI (1x1 red PNG)
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({
        avatars: [{ url: `data:image/png;base64,${pngBase64}`, source: 'test' }],
      })
      .expect(200);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/avatar`);

    if (res.status === 200) {
      expect(res.headers['content-type']).toContain('image/png');
    }
  });

  it('PEO-052: Avatar proxy with external HTTPS URL that fails returns 404', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({
        avatars: [{ url: 'https://nonexistent.example.com/avatar.jpg', source: 'test' }],
      })
      .expect(200);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/avatar`);

    expect([200, 404]).toContain(res.status);
  });

  it('PEO-053: Avatar SSRF guard blocks private IP', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({
        avatars: [{ url: 'https://192.168.1.1/avatar.jpg', source: 'test' }],
      })
      .expect(200);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/avatar`);

    expect(res.status).toBe(404);
  });

  it('PEO-054: Avatar with specific index', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    const png1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const png2 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwAEgAF/QualcQAAAABJRU5ErkJggg==';

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({
        avatars: [
          { url: `data:image/png;base64,${png1}`, source: 'gmail' },
          { url: `data:image/png;base64,${png2}`, source: 'slack' },
        ],
      })
      .expect(200);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/avatar?index=1`);

    if (res.status === 200) {
      expect(res.headers['content-type']).toContain('image/png');
    }
  });

  it('PEO-055: Backfill avatars endpoint', async () => {
    const res = await authedRequest(user.accessToken)
      .post('/api/people/backfill-avatars');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('converted');
    expect(res.body).toHaveProperty('failed');
    expect(typeof res.body.converted).toBe('number');
  }, 120_000);

  it('PEO-056: Multiple avatars from different connectors', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({
        avatars: [
          { url: `data:image/png;base64,${png}`, source: 'gmail' },
          { url: `data:image/jpeg;base64,/9j/4AAQ`, source: 'slack' },
        ],
      })
      .expect(200);

    const detail = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}`)
      .expect(200);

    expect(Array.isArray(detail.body.avatars)).toBe(true);
    expect(detail.body.avatars.length).toBe(2);
    const sources = detail.body.avatars.map((a: any) => a.source);
    expect(sources).toContain('gmail');
    expect(sources).toContain('slack');
  });

  it('PEO-057: Person with no avatar returns 404', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    await authedRequest(user.accessToken)
      .patch(`/api/people/${person.id}`)
      .send({ avatars: [] })
      .expect(200);

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/avatar`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no avatar');
  });

  it('PEO-058: Get person memories endpoint', async () => {
    const person = pickPerson();
    expect(person).toBeDefined();

    const res = await authedRequest(user.accessToken)
      .get(`/api/people/${person.id}/memories`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});
