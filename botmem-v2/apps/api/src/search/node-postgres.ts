import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from './postgres-ports.js';

/**
 * Concrete node-postgres adapter. An abort destroys the checked-out connection,
 * which cancels in-flight work without granting the API role pg_signal_backend.
 * Database statement_timeout remains the independent server-side backstop.
 */
export class NodePostgresPoolAdapter implements SqlPoolPort {
  private readonly pool: Pool;

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config);
    this.pool.on('error', () => {
      // The composition root owns sanitized operational reporting. Never log a
      // driver error here because PostgreSQL errors may echo query values.
    });
  }

  async connect(): Promise<SqlClientPort> {
    return new NodePostgresClientAdapter(await this.pool.connect());
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class NodePostgresClientAdapter implements SqlClientPort {
  private released = false;

  constructor(private readonly client: PoolClient) {}

  async query<Row>(config: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    if (config.signal?.aborted) {
      this.destroy();
      throw abortError();
    }
    const onAbort = () => this.destroy();
    config.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.client.query<Row & QueryResultRow>({
        text: config.text,
        ...(config.values ? { values: [...config.values] } : {}),
      });
      if (config.signal?.aborted) throw abortError();
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      if (config.signal?.aborted) throw abortError();
      throw error;
    } finally {
      config.signal?.removeEventListener('abort', onAbort);
    }
  }

  release(destroy = false): void {
    if (this.released) return;
    this.released = true;
    this.client.release(destroy);
  }

  private destroy(): void {
    this.release(true);
  }
}

function abortError(): Error {
  const error = new Error('database operation aborted');
  error.name = 'AbortError';
  return error;
}
