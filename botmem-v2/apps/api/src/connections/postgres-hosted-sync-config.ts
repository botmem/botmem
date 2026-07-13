import type { JsonValue } from '@botmem-v2/connector-domain';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import type { HostedSyncJobClaim } from './hosted-sync-job-store.js';
import type { HostedSyncAccountConfigReader } from './hosted-sync-worker.js';

export class PostgresHostedSyncAccountConfigReader implements HostedSyncAccountConfigReader {
  constructor(private readonly pool: SqlPoolPort) {}

  async readConnectionConfig(claim: HostedSyncJobClaim): Promise<JsonValue | null> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_worker' });
      await client.query({
        text: "SELECT set_config('botmem.tenant_id', $1, true)",
        values: [claim.tenantId],
      });
      const result = await client.query<{ readonly connection_config: JsonValue }>({
        text: `SELECT connection_config
                 FROM botmem.connector_account
                WHERE tenant_id = $1::uuid AND id = $2::uuid AND connector = $3
                  AND status IN ('ready', 'degraded')`,
        values: [claim.tenantId, claim.accountId, claim.connector],
      });
      await client.query({ text: 'COMMIT' });
      open = false;
      return result.rows[0]?.connection_config ?? null;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
