import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { afterAll, describe, expect, it } from 'vitest';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import {
  DeploymentKeyRing,
  PostgresConnectionAccountRepository,
  PostgresConnectorCredentialVault,
  PostgresConnectorOAuthStateStore,
} from './index.js';

const DATABASE_URL = process.env['BOTMEM_TEST_API_DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('hosted connection runtime real PostgreSQL', () => {
  const pool = new NodePostgresPoolAdapter({ connectionString: DATABASE_URL! });
  const tenant = tenantId('10000000-0000-4000-8000-000000000095');
  const accountId = connectorAccountId('20000000-0000-4000-8000-000000000095');
  const keyRing = new DeploymentKeyRing([{ version: 1, key: new Uint8Array(32).fill(7) }]);
  const vault = new PostgresConnectorCredentialVault(
    pool,
    keyRing,
    'botmem_api',
    () => '2026-07-13T10:00:00.000Z',
  );

  afterAll(async () => pool.close());

  it('atomicallyConsumesOAuthStateAndCreatesOnlyOwnerReadableEncryptedConnection', async () => {
    const states = new PostgresConnectorOAuthStateStore(pool);
    await states.save('gmail', {
      stateDigest: 'a'.repeat(64),
      tenantId: tenant,
      accountId,
      sealedPkceVerifier:
        'oauthseal:v1:1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCC',
      redirectUri: 'https://api.example.test/v2/connections/oauth/gmail/callback',
      scope: 'openid email gmail.readonly',
      createdAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T10:10:00.000Z',
    });
    await expect(
      states.consume('gmail', 'a'.repeat(64), '2026-07-13T10:01:00.000Z'),
    ).resolves.toMatchObject({ tenant_id: tenant, account_id: accountId });
    await expect(
      states.consume('gmail', 'a'.repeat(64), '2026-07-13T10:01:00.000Z'),
    ).resolves.toBeNull();

    const owner = { tenantId: tenant, accountId, connector: 'owntracks' as const };
    const reference = await vault.store(owner, {
      kind: 'owntracks_basic',
      value: { username: 'integration-user', password: 'integration-secret' },
    });
    const accounts = new PostgresConnectionAccountRepository(pool);
    const connected = await accounts.completeConnection({
      ...owner,
      authKind: 'basic',
      providerSubjectHash: 'b'.repeat(64),
      credentialRef: reference,
      displayLabel: 'OwnTracks · integration.example.test',
      connectionConfig: {
        endpoint: 'https://integration.example.test/api/0/locations',
        allowedPorts: [443],
      },
      initialCursor: {},
      connectedAt: '2026-07-13T10:00:00.000Z',
    });
    expect(connected).toMatchObject({ accountId, connector: 'owntracks', status: 'ready' });
    await expect(vault.read(owner, reference, 'owntracks_basic')).resolves.toEqual({
      username: 'integration-user',
      password: 'integration-secret',
    });
    await expect(
      vault.read(
        { ...owner, accountId: connectorAccountId('20000000-0000-4000-8000-000000000096') },
        reference,
        'owntracks_basic',
      ),
    ).rejects.toThrow();
  });
});
