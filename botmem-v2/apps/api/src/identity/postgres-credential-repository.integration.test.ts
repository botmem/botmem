import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import type { CredentialSnapshot } from './domain.js';
import { PostgresCredentialRepository } from './postgres-credential-repository.js';

const DATABASE_URL = process.env['BOTMEM_TEST_IDENTITY_DATABASE_URL'];
const enabled = Boolean(DATABASE_URL);
const TENANT_ID = '10000000-0000-4000-8000-000000000081';
const USER_ID = '20000000-0000-4000-8000-000000000081';
const HASH = '8'.repeat(64);
const REPLACEMENT_HASH = '7'.repeat(64);
const credential: CredentialSnapshot = {
  credentialId: '30000000-0000-4000-8000-000000000081',
  tenantId: TENANT_ID,
  workspaceId: TENANT_ID,
  userId: USER_ID,
  kind: 'personal_access_token',
  secretHashHex: HASH,
  tokenPrefix: 'Integration81',
  label: 'Identity integration',
  scopes: ['botmem:search'],
  createdAt: '2026-07-13T10:00:00.000Z',
  expiresAt: '2026-07-20T10:00:00.000Z',
};

describe.skipIf(!enabled)('PostgresCredentialRepository real PostgreSQL', () => {
  const admin = new Pool({ connectionString: DATABASE_URL });
  const pool = new NodePostgresPoolAdapter({ connectionString: DATABASE_URL });
  const repository = new PostgresCredentialRepository(pool);

  beforeAll(async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE botmem_identity_admin');
      await client.query(
        `INSERT INTO botmem.identity_user
           (id, tenant_id, email, email_lookup_hash, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'identity-integration@example.com',
                 decode(repeat('ee', 32), 'hex'), 'active',
                 $3::timestamptz, $3::timestamptz)`,
        [USER_ID, TENANT_ID, credential.createdAt],
      );
      await client.query(
        `INSERT INTO botmem.workspace
           (id, tenant_id, display_name, status, created_at, updated_at)
         VALUES ($1::uuid, $1::uuid, 'Identity integration', 'active',
                 $2::timestamptz, $2::timestamptz)`,
        [TENANT_ID, credential.createdAt],
      );
      await client.query(
        `INSERT INTO botmem.workspace_membership
           (tenant_id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES ($1::uuid, $1::uuid, $2::uuid, 'owner', 'active',
                 $3::timestamptz, $3::timestamptz)`,
        [TENANT_ID, USER_ID, credential.createdAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await repository.issue(credential);
  });

  afterAll(async () => {
    await pool.close();
    await admin.end();
  });

  it('authenticatesExactHashThenAtomicallyRotatesAndRevokesIt', async () => {
    await expect(
      repository.authenticate({
        secretHashHex: HASH,
        expectedKind: 'personal_access_token',
        now: '2026-07-13T11:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      tenantId: TENANT_ID,
      workspaceId: TENANT_ID,
      userId: USER_ID,
      membershipRole: 'owner',
    });
    await expect(
      repository.authenticate({
        secretHashHex: '9'.repeat(64),
        expectedKind: 'personal_access_token',
        now: '2026-07-13T11:00:00.000Z',
      }),
    ).resolves.toBeNull();
    await repository.rotate({
      currentSecretHashHex: HASH,
      currentKind: 'personal_access_token',
      replacement: {
        ...credential,
        credentialId: '30000000-0000-4000-8000-000000000082',
        secretHashHex: REPLACEMENT_HASH,
        tokenPrefix: 'Replacement82',
        createdAt: '2026-07-13T12:00:00.000Z',
        rotatedFromCredentialId: credential.credentialId,
      },
      rotatedAt: '2026-07-13T12:00:00.000Z',
    });
    await expect(
      repository.authenticate({
        secretHashHex: HASH,
        expectedKind: 'personal_access_token',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.authenticate({
        secretHashHex: REPLACEMENT_HASH,
        expectedKind: 'personal_access_token',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).resolves.toMatchObject({
      credentialId: '30000000-0000-4000-8000-000000000082',
    });
    await expect(
      repository.revoke({
        secretHashHex: REPLACEMENT_HASH,
        expectedKind: 'personal_access_token',
        revokedAt: '2026-07-13T13:00:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      repository.authenticate({
        secretHashHex: REPLACEMENT_HASH,
        expectedKind: 'personal_access_token',
        now: '2026-07-13T13:01:00.000Z',
      }),
    ).resolves.toBeNull();
  });

  it('createsAndConsumesOneHashOnlyEmailResolvedLoginChallenge', async () => {
    const challengeHash = '6'.repeat(64);
    await expect(
      repository.begin({
        emailLookupHashHex: 'e'.repeat(64),
        challengeId: '40000000-0000-4000-8000-000000000081',
        secretHashHex: challengeHash,
        createdAt: '2026-07-13T10:00:00.000Z',
        expiresAt: '2026-07-13T10:15:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      repository.begin({
        emailLookupHashHex: 'e'.repeat(64),
        challengeId: '40000000-0000-4000-8000-000000000082',
        secretHashHex: '5'.repeat(64),
        createdAt: '2026-07-13T10:00:30.000Z',
        expiresAt: '2026-07-13T10:15:30.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      repository.consume({
        secretHashHex: challengeHash,
        consumedAt: '2026-07-13T10:01:00.000Z',
      }),
    ).resolves.toMatchObject({
      challengeId: '40000000-0000-4000-8000-000000000081',
      workspaceId: TENANT_ID,
      userId: USER_ID,
      membershipRole: 'owner',
    });
    await expect(
      repository.consume({
        secretHashHex: challengeHash,
        consumedAt: '2026-07-13T10:02:00.000Z',
      }),
    ).resolves.toBeNull();
  });
});
