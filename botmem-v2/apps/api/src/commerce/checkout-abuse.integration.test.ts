import { describe, expect, it } from 'vitest';
import { NodeTokenSecurity } from '../identity/token-security.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { PostgresCheckoutAbuseGuard } from './checkout-abuse.js';
import { CheckoutRateLimitError } from './domain.js';
import { IdentityEmailLookupHasher } from './email-lookup.js';

const API_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];

describe.skipIf(!API_URL)('checkout distributed admission real PostgreSQL', () => {
  it('shares a client cap across guard instances without storing an address', async () => {
    const poolA = new NodePostgresPoolAdapter({ connectionString: API_URL! });
    const poolB = new NodePostgresPoolAdapter({ connectionString: API_URL! });
    const security = new NodeTokenSecurity(new Uint8Array(32).fill(23));
    const email = new IdentityEmailLookupHasher(security);
    const now = Date.now();
    const guardA = new PostgresCheckoutAbuseGuard(poolA, security, email, { nowMs: () => now });
    const guardB = new PostgresCheckoutAbuseGuard(poolB, security, email, { nowMs: () => now });

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await (attempt % 2 ? guardA : guardB).admit({
          email: `distributed-${attempt}@example.test`,
          clientAddress: '203.0.113.44',
        });
      }
      await expect(
        guardA.admit({
          email: 'distributed-final@example.test',
          clientAddress: '203.0.113.44',
        }),
      ).rejects.toBeInstanceOf(CheckoutRateLimitError);
    } finally {
      await Promise.all([poolA.close(), poolB.close()]);
    }
  });
});
