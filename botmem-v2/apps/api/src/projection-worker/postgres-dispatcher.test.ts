import { describe, expect, it, vi } from 'vitest';
import type { SqlClientPort, SqlPoolPort, SqlQueryConfig } from '../search/postgres-ports.js';
import {
  OutboxSettlementConflictError,
  PostgresOutboxDispatcher,
} from './postgres-dispatcher.js';

describe('PostgresOutboxDispatcher', () => {
  it('claims expired or due rows with skip-locked SQL and never selects payload', async () => {
    const queries: SqlQueryConfig[] = [];
    const client = fakeClient(queries, (query) =>
      query.text.includes('WITH claimable')
        ? {
            rows: [
              {
                id: '10000000-0000-4000-8000-000000000001',
                tenant_id: '20000000-0000-4000-8000-000000000002',
                account_id: '30000000-0000-4000-8000-000000000003',
                revision_id: '40000000-0000-4000-8000-000000000004',
                attempts: 2,
                lease_token: '50000000-0000-4000-8000-000000000005',
                lease_expires_at: '2026-07-13T10:01:00.000Z',
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: null },
    );
    const dispatcher = new PostgresOutboxDispatcher(fakePool(client));

    await expect(
      dispatcher.claim({
        owner: 'projection-1',
        limit: 8,
        leaseMs: 60_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([expect.objectContaining({ attempt: 2 })]);

    const claim = queries.find((query) => query.text.includes('WITH claimable'))?.text ?? '';
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain("state = 'processing'");
    expect(claim.toLowerCase()).not.toMatch(/\bpayload\b/u);
    expect(queries.some((query) => query.text === 'SET LOCAL ROLE botmem_dispatcher')).toBe(true);
  });

  it('settles only a processing row owned by the caller', async () => {
    const queries: SqlQueryConfig[] = [];
    const client = fakeClient(queries, (query) =>
      query.text.startsWith('UPDATE botmem.transactional_outbox')
        ? { rows: [], rowCount: 1 }
        : { rows: [], rowCount: null },
    );
    const dispatcher = new PostgresOutboxDispatcher(fakePool(client));
    await dispatcher.complete({
      messageId: '10000000-0000-4000-8000-000000000001',
      owner: 'projection-1',
      leaseToken: '50000000-0000-4000-8000-000000000005',
      publishedAt: '2026-07-13T10:00:00.000Z',
      signal: new AbortController().signal,
    });
    const update = queries.find((query) =>
      query.text.startsWith('UPDATE botmem.transactional_outbox'),
    );
    expect(update?.text).toContain('lease_owner = $2 AND lease_token = $3::uuid');
    expect(update?.values?.[2]).toBe('50000000-0000-4000-8000-000000000005');
  });

  it('rejects a stale token when a reused owner id has a newer claim', async () => {
    const queries: SqlQueryConfig[] = [];
    const client = fakeClient(queries, (query) =>
      query.text.startsWith('UPDATE botmem.transactional_outbox')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: null },
    );
    const dispatcher = new PostgresOutboxDispatcher(fakePool(client));

    await expect(
      dispatcher.complete({
        messageId: '10000000-0000-4000-8000-000000000001',
        owner: 'projection-reused',
        leaseToken: '50000000-0000-4000-8000-000000000001',
        publishedAt: '2026-07-13T10:00:00.000Z',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OutboxSettlementConflictError);
  });
});

function fakePool(client: SqlClientPort): SqlPoolPort {
  return { connect: vi.fn().mockResolvedValue(client) };
}

function fakeClient(
  queries: SqlQueryConfig[],
  respond: (query: SqlQueryConfig) => { rows: readonly unknown[]; rowCount: number | null },
): SqlClientPort {
  return {
    query: vi.fn(async (query: SqlQueryConfig) => {
      queries.push(query);
      return respond(query);
    }) as SqlClientPort['query'],
    release: vi.fn(),
  };
}
