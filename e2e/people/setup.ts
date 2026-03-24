/**
 * Shared setup for people e2e tests.
 * Creates a test user and works with whatever people exist.
 * NO demo seed — Typesense can't handle 300 rapid sequential upserts in dev.
 */
import {
  ensureApiRunning,
  registerUser,
  authedRequest,
  type TestUser,
} from '../helpers/index.js';

let _user: TestUser | null = null;
let _people: any[] = [];
let _initialized = false;

/**
 * Initialize test user and fetch existing people.
 * Creates 3 test people via PATCH if none exist.
 */
export async function seedOnce(): Promise<{ user: TestUser; people: any[] }> {
  if (_initialized && _user) {
    return { user: _user, people: _people };
  }

  await ensureApiRunning();
  _user = await registerUser();
  await authedRequest(_user.accessToken)
    .post('/api/user-auth/recovery-key')
    .send({ recoveryKey: _user.recoveryKey })
    .expect(200);

  // Try to get existing people (from previous seeds or syncs)
  const res = await authedRequest(_user.accessToken).get('/api/people?limit=100').expect(200);
  _people = res.body.items ?? [];

  // If no people exist for this fresh user, try a quick demo seed
  if (_people.length === 0) {
    try {
      const seedRes = await authedRequest(_user.accessToken).post('/api/demo/seed');
      // Give Typesense a moment to settle
      if ([200, 201].includes(seedRes.status)) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      const res2 = await authedRequest(_user.accessToken).get('/api/people?limit=100').expect(200);
      _people = res2.body.items ?? [];
    } catch {
      // Demo seed failed (Typesense overloaded) — continue with empty people
    }
  }

  _initialized = true;
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
 * Clean up — delete demo data if it was seeded.
 */
export async function cleanupSeed(): Promise<void> {
  if (_user?.accessToken) {
    try {
      await authedRequest(_user.accessToken).delete('/api/demo/seed');
    } catch {}
  }
}
