/**
 * E2E test app helper.
 * Tests run against an already-running API server (default: http://localhost:12412).
 * Set E2E_API_URL env var to override.
 */

const BASE_URL = process.env.E2E_API_URL || 'http://localhost:12412';

/**
 * Get the base URL for the running API server.
 */
export function getBaseUrl(): string {
  return BASE_URL;
}

/**
 * Boot check — call in beforeAll to verify the API is reachable.
 */
export async function ensureApiRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/version`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `E2E tests require a running API at ${BASE_URL}. ` +
        `Start with: pnpm dev\n` +
        `Original error: ${err}`,
    );
  }
}

/**
 * No-op close — kept for API compatibility with existing test files.
 */
export async function closeApp(): Promise<void> {
  // Nothing to close — tests hit an external server
}

/**
 * Get the base URL (replaces getHttpServer for supertest).
 * supertest accepts a URL string as well as an http.Server.
 */
export function getHttpServer(): string {
  return BASE_URL;
}

/**
 * Whether we're running in external-server mode (no in-process NestJS app).
 */
export const isExternalServer = true;

/**
 * getService is not available in external-server mode.
 * Throws immediately so tests that use it should be guarded with:
 *   it.skipIf(isExternalServer)('test name', ...)
 */
export function getService<T>(_token: any): T {
  throw new Error(
    'getService() is not available in external-server e2e mode. ' +
      'Guard this test with it.skipIf(isExternalServer).',
  );
}
