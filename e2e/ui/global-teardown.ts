/**
 * Playwright global teardown — cleans up test users created during the test run.
 * Deletes all users with emails matching pw-*@test.botmem.xyz via direct DB cleanup.
 */

const API_BASE = 'http://localhost:12412/api';

export default async function globalTeardown() {
  // Call a lightweight cleanup endpoint that removes test users
  // We use the demo/cleanup-test-users endpoint if available,
  // otherwise this is a no-op (test users accumulate but have unique emails)
  try {
    const res = await fetch(`${API_BASE}/demo/cleanup-test-users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailPattern: 'pw-%@test.botmem.xyz' }),
    });
    if (res.ok) {
      const body = await res.json();
      console.log(`[teardown] Cleaned up ${body.deleted ?? '?'} test users`);
    }
  } catch {
    // Server may be down — silently skip cleanup
  }
}
