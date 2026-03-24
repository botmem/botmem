/**
 * Shared setup for people e2e tests.
 * Seeds demo data once and caches the user + people list across all test files.
 * Since vitest runs in singleFork mode, this module state persists.
 */
import {
  ensureApiRunning,
  registerUser,
  authedRequest,
  type TestUser,
} from '../helpers/index.js';

let _user: TestUser | null = null;
let _people: any[] = [];
let _seeded = false;

/**
 * Ensure demo data is seeded. Idempotent — only seeds on first call.
 * Returns { user, people } for tests to use.
 */
export async function seedOnce(): Promise<{ user: TestUser; people: any[] }> {
  if (_seeded && _user) {
    return { user: _user, people: _people };
  }

  await ensureApiRunning();
  _user = await registerUser();
  await authedRequest(_user.accessToken)
    .post('/api/user-auth/recovery-key')
    .send({ recoveryKey: _user.recoveryKey })
    .expect(200);

  // Demo seed — creates 100 contacts, ~300 memories, ~200 links, pre-embedded.
  // May return 500 if Typesense is overloaded (contacts still created in PostgreSQL).
  const seedRes = await authedRequest(_user.accessToken).post('/api/demo/seed');
  if (![200, 201, 500].includes(seedRes.status)) {
    throw new Error(`Demo seed failed with status ${seedRes.status}: ${JSON.stringify(seedRes.body)}`);
  }

  // Fetch seeded people — contacts are in PostgreSQL even if Typesense upsert failed
  const res = await authedRequest(_user.accessToken).get('/api/people?limit=100').expect(200);
  _people = res.body.items;
  if (_people.length === 0) {
    throw new Error('Demo seed produced 0 people — is PostgreSQL healthy?');
  }

  _seeded = true;
  return { user: _user, people: _people };
}

/**
 * Refresh the people list from the API (after mutations).
 */
export async function refreshPeople(): Promise<any[]> {
  if (!_user) throw new Error('Must call seedOnce() first');
  const res = await authedRequest(_user.accessToken).get('/api/people?limit=100').expect(200);
  _people = res.body.items;
  return _people;
}

/**
 * Clean up demo data. Call in the last test file's afterAll.
 */
export async function cleanupSeed(): Promise<void> {
  if (_user?.accessToken) {
    await authedRequest(_user.accessToken).delete('/api/demo/seed');
  }
}
