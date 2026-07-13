import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type { ClaimedOutboxMessage, OutboxDispatcherPort } from './ports.js';

interface ClaimedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly revision_id: string;
  readonly attempts: number;
  readonly lease_token: string;
  readonly lease_expires_at: Date | string;
}

/** Content-blind dispatcher adapter; every SELECT names only granted routing columns. */
export class PostgresOutboxDispatcher implements OutboxDispatcherPort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly statementTimeoutMs = 5_000,
  ) {
    if (statementTimeoutMs < 100 || statementTimeoutMs > 30_000) {
      throw new RangeError('dispatcher statement timeout must be between 100 and 30000ms');
    }
  }

  async claim(input: {
    readonly owner: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimedOutboxMessage[]> {
    validateOwner(input.owner);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) {
      throw new RangeError('outbox claim limit must be between 1 and 64');
    }
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 5_000 || input.leaseMs > 300_000) {
      throw new RangeError('outbox lease must be between 5 seconds and 5 minutes');
    }
    return this.transaction(input.signal, async (client) => {
      const result = await client.query<ClaimedRow>({
        text: CLAIM_SQL,
        values: [input.owner, input.leaseMs, input.limit],
        signal: input.signal,
      });
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            messageId: row.id,
            workspaceId: row.tenant_id,
            accountId: row.account_id,
            revisionId: row.revision_id,
            attempt: Number(row.attempts),
            leaseToken: row.lease_token,
            leaseExpiresAt: iso(row.lease_expires_at),
          }),
        ),
      );
    });
  }

  async complete(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly publishedAt: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    validateOwner(input.owner);
    await this.transaction(input.signal, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.transactional_outbox
                  SET state = 'published', lease_owner = NULL,
                      lease_token = NULL, lease_expires_at = NULL,
                      published_at = $4::timestamptz,
                      next_attempt_at = $4::timestamptz
                WHERE id = $1::uuid AND state = 'processing'
                  AND lease_owner = $2 AND lease_token = $3::uuid
                  AND lease_expires_at > $4::timestamptz`,
        values: [input.messageId, input.owner, input.leaseToken, input.publishedAt],
        signal: input.signal,
      });
      if (result.rowCount !== 1) throw new OutboxSettlementConflictError();
    });
  }

  async fail(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly leaseToken: string;
    readonly dead: boolean;
    readonly failedAt: string;
    readonly nextAttemptAt: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    validateOwner(input.owner);
    await this.transaction(input.signal, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.transactional_outbox
                  SET state = CASE WHEN $5::boolean THEN 'dead' ELSE 'pending' END,
                      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                      next_attempt_at = $6::timestamptz, published_at = NULL
                WHERE id = $1::uuid AND state = 'processing'
                  AND lease_owner = $2 AND lease_token = $3::uuid
                  AND lease_expires_at > $4::timestamptz`,
        values: [
          input.messageId,
          input.owner,
          input.leaseToken,
          input.failedAt,
          input.dead,
          input.nextAttemptAt,
        ],
        signal: input.signal,
      });
      if (result.rowCount !== 1) throw new OutboxSettlementConflictError();
    });
  }

  async listRepairWorkspaces(input: {
    readonly afterWorkspaceId?: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<readonly string[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('repair workspace limit must be between 1 and 500');
    }
    return this.transaction(input.signal, async (client) => {
      const result = await client.query<{ tenant_id: string }>({
        text: `SELECT DISTINCT tenant_id
                 FROM botmem.transactional_outbox
                WHERE ($1::uuid IS NULL OR tenant_id > $1::uuid)
                ORDER BY tenant_id
                LIMIT $2::integer`,
        values: [input.afterWorkspaceId ?? null, input.limit],
        signal: input.signal,
      });
      return Object.freeze(result.rows.map((row) => row.tenant_id));
    });
  }

  private async transaction<T>(
    signal: AbortSignal,
    operation: (client: SqlClientPort) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw abortError();
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query({ text: 'BEGIN', signal });
      transactionOpen = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_dispatcher', signal });
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal,
      });
      const value = await operation(client);
      await client.query({ text: 'COMMIT', signal });
      transactionOpen = false;
      return value;
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const CLAIM_SQL = `
WITH claimable AS (
  SELECT id
    FROM botmem.transactional_outbox
   WHERE (
     state = 'pending' AND next_attempt_at <= statement_timestamp()
   ) OR (
     state = 'processing' AND lease_expires_at <= statement_timestamp()
   )
   ORDER BY next_attempt_at, created_at, id
   FOR UPDATE SKIP LOCKED
   LIMIT $3::integer
)
UPDATE botmem.transactional_outbox outbox
   SET state = 'processing', attempts = outbox.attempts + 1,
       lease_owner = $1,
       lease_token = gen_random_uuid(),
       lease_expires_at = statement_timestamp() + ($2::integer * interval '1 millisecond'),
       published_at = NULL
  FROM claimable
 WHERE outbox.id = claimable.id
RETURNING outbox.id, outbox.tenant_id, outbox.account_id, outbox.revision_id,
          outbox.attempts, outbox.lease_token, outbox.lease_expires_at
`;

function validateOwner(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new TypeError('outbox owner is invalid');
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function abortError(): Error {
  const error = new Error('dispatcher operation aborted');
  error.name = 'AbortError';
  return error;
}

export class OutboxSettlementConflictError extends Error {}
