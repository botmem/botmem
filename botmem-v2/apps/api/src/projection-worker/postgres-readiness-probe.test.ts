import { describe, expect, it, vi } from 'vitest';
import type { SqlClientPort, SqlPoolPort, SqlQueryConfig } from '../search/postgres-ports.js';
import { PostgresSearchReadinessProbe } from './postgres-readiness-probe.js';

const command = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  accountId: '20000000-0000-4000-8000-000000000002',
  signal: new AbortController().signal,
};

describe('PostgresSearchReadinessProbe', () => {
  it('does not run search operators while projection or embedding debt remains', async () => {
    const queries: SqlQueryConfig[] = [];
    const probe = new PostgresSearchReadinessProbe(
      pool(queries, {
        projection_debt: 1,
        embedding_debt: 0,
        profile_ready: true,
      }),
    );
    await expect(probe.probe(command)).resolves.toBe('deferred');
    expect(queries.some((query) => query.text.includes('lexical_probe'))).toBe(false);
  });

  it('runs real lexical and vector SQL only after debt is zero', async () => {
    const queries: SqlQueryConfig[] = [];
    const probe = new PostgresSearchReadinessProbe(
      pool(queries, {
        projection_debt: 0,
        embedding_debt: 0,
        profile_ready: true,
      }),
    );
    await expect(probe.probe(command)).resolves.toBe('ready');
    const search = queries.find((query) => query.text.includes('lexical_probe'))?.text ?? '';
    expect(search).toContain('plainto_tsquery');
    expect(search).toContain('<=>');
  });
});

function pool(queries: SqlQueryConfig[], debt: Record<string, unknown>): SqlPoolPort {
  const client: SqlClientPort = {
    query: vi.fn(async (query: SqlQueryConfig) => {
      queries.push(query);
      if (query.text.includes('AS projection_debt')) return { rows: [debt], rowCount: 1 };
      if (query.text.includes('lexical_probe')) return { rows: [{ ok: true }], rowCount: 1 };
      return { rows: [], rowCount: null };
    }) as SqlClientPort['query'],
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client) };
}
