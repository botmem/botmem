import { isIP } from 'node:net';
import type { TokenSecurityPort } from '../identity/ports.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import {
  BillingUnavailableError,
  CheckoutRateLimitError,
  normalizeBillingEmail,
} from './domain.js';
import type { EmailLookupHashPort } from './ports.js';

export interface CheckoutAbuseGuardPort {
  admit(input: { readonly email: string; readonly clientAddress: string }): Promise<void>;
}

interface AdmissionRow {
  readonly accepted: boolean;
  readonly retry_after_seconds: number;
}

/** PostgreSQL is the shared limiter so replicas cannot multiply checkout work. */
export class PostgresCheckoutAbuseGuard implements CheckoutAbuseGuardPort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly tokens: Pick<TokenSecurityPort, 'hash'>,
    private readonly emailLookup: EmailLookupHashPort,
    private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() },
  ) {}

  async admit(input: { readonly email: string; readonly clientAddress: string }): Promise<void> {
    const email = normalizeBillingEmail(input.email);
    const address = input.clientAddress.trim().toLowerCase();
    if (isIP(address) === 0) throw new BillingUnavailableError();
    const [emailHash, clientHash] = await Promise.all([
      this.emailLookup.hashCanonicalEmail(email),
      this.tokens.hash(`checkout-client:${address}`),
    ]);
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      const result = await client.query<AdmissionRow>({
        text: `SELECT accepted, retry_after_seconds
                 FROM botmem.consume_billing_checkout_attempt(
                   decode($1, 'hex'), decode($2, 'hex'), $3::timestamptz
                 )`,
        values: [clientHash, emailHash, new Date(this.clock.nowMs()).toISOString()],
      });
      await client.query({ text: 'COMMIT' });
      open = false;
      const row = result.rows[0];
      if (!row) throw new BillingUnavailableError();
      if (!row.accepted) throw new CheckoutRateLimitError(row.retry_after_seconds);
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      if (error instanceof CheckoutRateLimitError || error instanceof BillingUnavailableError) {
        throw error;
      }
      throw new BillingUnavailableError();
    } finally {
      client.release();
    }
  }
}
