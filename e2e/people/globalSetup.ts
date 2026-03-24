/**
 * Vitest globalSetup for people tests.
 * Seeds demo data ONCE before all test files run.
 * Writes credentials to a temp file that test files read.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SEED_FILE = join(__dirname, '.seed-cache.json');

export async function setup() {
  const baseUrl = process.env.E2E_API_URL || 'http://localhost:12412';

  // 1. Register user
  const regRes = await fetch(`${baseUrl}/api/user-auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `people-seed-${Date.now()}@test.botmem.xyz`,
      password: 'TestPass123!',
      name: 'People E2E Seed',
    }),
  });
  if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`);
  const reg = await regRes.json();

  // 2. Submit recovery key
  await fetch(`${baseUrl}/api/user-auth/recovery-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${reg.accessToken}`,
    },
    body: JSON.stringify({ recoveryKey: reg.recoveryKey }),
  });

  // 3. Demo seed
  const seedRes = await fetch(`${baseUrl}/api/demo/seed`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${reg.accessToken}` },
  });
  if (![200, 201, 500].includes(seedRes.status)) {
    throw new Error(`Demo seed failed: ${seedRes.status}`);
  }

  // 4. Fetch people
  const peopleRes = await fetch(`${baseUrl}/api/people?limit=100`, {
    headers: { Authorization: `Bearer ${reg.accessToken}` },
  });
  const peopleData = await peopleRes.json();

  // 5. Write to cache file for test files to read
  writeFileSync(
    SEED_FILE,
    JSON.stringify({
      user: {
        id: reg.user.id,
        email: reg.user.email ?? reg.email,
        password: 'TestPass123!',
        name: 'People E2E Seed',
        accessToken: reg.accessToken,
        recoveryKey: reg.recoveryKey,
      },
      people: peopleData.items ?? [],
    }),
  );

  console.log(`[people globalSetup] Seeded ${peopleData.items?.length ?? 0} people`);
}

export async function teardown() {
  // Read cache to get token for cleanup
  try {
    const { readFileSync, unlinkSync } = await import('fs');
    const data = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
    const baseUrl = process.env.E2E_API_URL || 'http://localhost:12412';

    await fetch(`${baseUrl}/api/demo/seed`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${data.user.accessToken}` },
    });

    unlinkSync(SEED_FILE);
  } catch {}
}
