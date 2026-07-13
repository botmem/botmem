import { describe, expect, it } from 'vitest';
import { PostgresHostedSourceStatusReader } from './postgres-source-status.js';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from './postgres-ports.js';

describe('PostgresHostedSourceStatusReader', () => {
  it('list_whenAllEvidenceExists_returnsCanonicalReadyStatus', async () => {
    const client: SqlClientPort = {
      query: async <Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> => {
        if (query.text.includes('WITH profile AS')) {
          return {
            rows: [
              {
                connector: 'gmail',
                readiness: 'ready',
                searchable: true,
                indexed_count: '42',
                checkpoint_at: new Date('2026-07-13T10:00:00Z'),
                last_probe_at: new Date('2026-07-13T10:01:00Z'),
                reason_code: null,
              },
            ] as Row[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: null };
      },
      release: () => undefined,
    };
    const pool: SqlPoolPort = { connect: async () => client };

    await expect(
      new PostgresHostedSourceStatusReader(pool).list(
        '10000000-0000-4000-8000-000000000001',
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      {
        connector: 'gmail',
        readiness: 'ready',
        searchable: true,
        indexedCount: 42,
        checkpointAt: '2026-07-13T10:00:00.000Z',
        lastProbeAt: '2026-07-13T10:01:00.000Z',
      },
    ]);
  });
});
