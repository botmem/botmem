import type { HostedProjectionInput } from '../search/hosted-projection-transformer.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import type { HostedProjectionInputPort } from './ports.js';

interface InputRow {
  readonly account_id: string;
  readonly connector: 'gmail' | 'outlook' | 'owntracks';
  readonly source_event_id: string;
  readonly source_revision: string;
  readonly kind: 'email' | 'location';
  readonly occurred_at: Date | string | null;
  readonly tombstone: boolean;
  readonly payload: unknown;
}

/** Tenant-scoped content loader. This is never constructed with dispatcher credentials. */
export class PostgresHostedProjectionInputReader implements HostedProjectionInputPort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly statementTimeoutMs = 5_000,
  ) {
    if (statementTimeoutMs < 100 || statementTimeoutMs > 30_000) {
      throw new RangeError('input statement timeout must be between 100 and 30000ms');
    }
  }

  async load(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly revisionId: string;
    readonly signal: AbortSignal;
  }): Promise<HostedProjectionInput> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query({ text: 'BEGIN', signal: input.signal });
      transactionOpen = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_worker', signal: input.signal });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [input.workspaceId],
        signal: input.signal,
      });
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal: input.signal,
      });
      const result = await client.query<InputRow>({
        text: `SELECT revision.account_id, account.connector,
                      revision.source_event_id, revision.source_revision,
                      revision.kind, revision.occurred_at, revision.tombstone,
                      revision.payload
                 FROM botmem.ingest_event_revision revision
                 JOIN botmem.connector_account account
                   ON account.tenant_id = revision.tenant_id
                  AND account.id = revision.account_id
                WHERE revision.tenant_id = $1::uuid
                  AND revision.account_id = $2::uuid
                  AND revision.id = $3::uuid`,
        values: [input.workspaceId, input.accountId, input.revisionId],
        signal: input.signal,
      });
      const row = result.rows[0];
      if (!row) throw new ProjectionInputUnavailableError();
      await client.query({ text: 'COMMIT', signal: input.signal });
      transactionOpen = false;
      return Object.freeze({
        workspaceId: input.workspaceId,
        accountId: row.account_id,
        revisionId: input.revisionId,
        connector: row.connector,
        sourceEventId: row.source_event_id,
        sourceRevision: row.source_revision,
        kind: row.kind,
        occurredAt: row.occurred_at === null ? null : iso(row.occurred_at),
        tombstone: row.tombstone,
        payload: row.payload,
      });
    } catch (error) {
      if (transactionOpen) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export class ProjectionInputUnavailableError extends Error {}
