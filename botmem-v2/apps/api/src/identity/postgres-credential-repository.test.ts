import { describe, expect, it } from 'vitest';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from '../search/postgres-ports.js';
import { PostgresCredentialRepository } from './postgres-credential-repository.js';

class IdentityClient implements SqlClientPort {
  readonly queries: SqlQueryConfig[] = [];
  released = false;

  async query<Row>(query: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    this.queries.push(query);
    if (query.text.includes('FROM botmem.identity_credential')) {
      return result({
        id: '30000000-0000-4000-8000-000000000001',
        tenant_id: '10000000-0000-4000-8000-000000000001',
        workspace_id: '10000000-0000-4000-8000-000000000001',
        user_id: '20000000-0000-4000-8000-000000000001',
        kind: 'personal_access_token',
        scopes: ['botmem:search'],
        expires_at: '2026-07-20T10:00:00.000Z',
      }) as SqlQueryResult<Row>;
    }
    if (query.text.includes('FROM botmem.workspace_membership membership')) {
      return result({ role: 'owner' }) as SqlQueryResult<Row>;
    }
    return { rows: [], rowCount: query.text.startsWith('UPDATE') ? 1 : null };
  }

  release(): void {
    this.released = true;
  }
}

function result<Row>(row: Row): SqlQueryResult<Row> {
  return { rows: [row], rowCount: 1 };
}

describe('PostgresCredentialRepository', () => {
  it('authenticate_scopesBootstrapLookupThenChecksRlsMembership', async () => {
    const client = new IdentityClient();
    const pool: SqlPoolPort = { connect: async () => client };
    const repository = new PostgresCredentialRepository(pool);
    const hash = 'a'.repeat(64);

    await expect(
      repository.authenticate({
        secretHashHex: hash,
        expectedKind: 'personal_access_token',
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      workspaceId: '10000000-0000-4000-8000-000000000001',
      credentialKind: 'personal_access_token',
      membershipRole: 'owner',
    });

    expect(client.queries.map((query) => query.text)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE botmem_api',
      "SELECT set_config('botmem.credential_hash', $1, true)",
      expect.stringContaining('FROM botmem.identity_credential'),
      expect.stringContaining("set_config('botmem.tenant_id'"),
      expect.stringContaining('FROM botmem.workspace_membership membership'),
      expect.stringContaining('UPDATE botmem.identity_credential'),
      'COMMIT',
    ]);
    expect(client.queries[2]?.values).toEqual([hash]);
    expect(client.queries[3]?.text).not.toContain(hash);
    expect(client.released).toBe(true);
  });
});
