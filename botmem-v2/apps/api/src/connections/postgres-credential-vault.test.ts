import { connectorAccountId, tenantId } from '@botmem-v2/connector-domain';
import { describe, expect, it } from 'vitest';
import type {
  SqlClientPort,
  SqlPoolPort,
  SqlQueryConfig,
  SqlQueryResult,
} from '../search/postgres-ports.js';
import {
  ConnectorCredentialError,
  DeploymentKeyRing,
  PostgresConnectorCredentialVault,
} from './index.js';

const OWNER = {
  tenantId: tenantId('10000000-0000-4000-8000-000000000001'),
  accountId: connectorAccountId('20000000-0000-4000-8000-000000000001'),
  connector: 'owntracks' as const,
};

interface StoredRow {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly connector: string;
  readonly secretKind: 'owntracks_basic';
  keyVersion: number;
  wrapNonce: Buffer;
  wrappedKey: Buffer;
  wrapTag: Buffer;
  payloadNonce: Buffer;
  ciphertext: Buffer;
  payloadTag: Buffer;
  revoked: boolean;
}

class MemoryClient implements SqlClientPort {
  row: StoredRow | null = null;
  observedValues: readonly unknown[] = [];

  async query<Row = Record<string, unknown>>(config: SqlQueryConfig): Promise<SqlQueryResult<Row>> {
    const text = config.text.replace(/\s+/gu, ' ').trim();
    if (text.startsWith('INSERT INTO botmem.connector_credential')) {
      const value = config.values!;
      this.observedValues = value;
      this.row = {
        id: String(value[0]),
        tenantId: String(value[1]),
        accountId: String(value[2]),
        connector: String(value[3]),
        secretKind: value[4] as 'owntracks_basic',
        keyVersion: Number(value[5]),
        wrapNonce: value[6] as Buffer,
        wrappedKey: value[7] as Buffer,
        wrapTag: value[8] as Buffer,
        payloadNonce: value[9] as Buffer,
        ciphertext: value[10] as Buffer,
        payloadTag: value[11] as Buffer,
        revoked: false,
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT key_version')) {
      const value = config.values!;
      const matches =
        this.row &&
        !this.row.revoked &&
        this.row.tenantId === value[0] &&
        this.row.accountId === value[1] &&
        this.row.id === value[2] &&
        this.row.connector === value[3];
      const rows = matches
        ? [
            {
              key_version: this.row!.keyVersion,
              secret_kind: this.row!.secretKind,
              wrap_nonce: this.row!.wrapNonce,
              wrapped_key: this.row!.wrappedKey,
              wrap_tag: this.row!.wrapTag,
              payload_nonce: this.row!.payloadNonce,
              ciphertext: this.row!.ciphertext,
              payload_tag: this.row!.payloadTag,
            } as Row,
          ]
        : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('SET key_version = $6')) {
      if (!this.matches(config.values)) return { rows: [], rowCount: 0 };
      const value = config.values!;
      this.row!.keyVersion = Number(value[5]);
      this.row!.wrapNonce = value[6] as Buffer;
      this.row!.wrappedKey = value[7] as Buffer;
      this.row!.wrapTag = value[8] as Buffer;
      this.row!.payloadNonce = value[9] as Buffer;
      this.row!.ciphertext = value[10] as Buffer;
      this.row!.payloadTag = value[11] as Buffer;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SET key_version = $4')) {
      if (!this.matches(config.values)) return { rows: [], rowCount: 0 };
      const value = config.values!;
      this.row!.keyVersion = Number(value[3]);
      this.row!.wrapNonce = value[4] as Buffer;
      this.row!.wrappedKey = value[5] as Buffer;
      this.row!.wrapTag = value[6] as Buffer;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SET revoked_at = $4')) {
      if (!this.matches(config.values)) return { rows: [], rowCount: 0 };
      if (this.row!.revoked) return { rows: [], rowCount: 0 };
      this.row!.revoked = true;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT 1 FROM botmem.connector_credential')) {
      const exists = Boolean(this.matches(config.values) && this.row?.revoked);
      return { rows: exists ? ([{}] as Row[]) : [], rowCount: exists ? 1 : 0 };
    }
    return { rows: [], rowCount: null };
  }

  private matches(values: readonly unknown[] | undefined): boolean {
    return Boolean(
      values &&
      this.row &&
      this.row.tenantId === values[0] &&
      this.row.accountId === values[1] &&
      this.row.id === values[2],
    );
  }

  release(): void {}
}

describe('PostgresConnectorCredentialVault', () => {
  it('storeAndRead_usesEnvelopeCiphertextAndExactOwnerContext', async () => {
    const client = new MemoryClient();
    const pool: SqlPoolPort = { connect: async () => client };
    const ring = new DeploymentKeyRing([{ version: 7, key: new Uint8Array(32).fill(9) }]);
    const vault = new PostgresConnectorCredentialVault(
      pool,
      ring,
      'botmem_api',
      () => '2026-07-13T10:00:00.000Z',
    );
    const secret = { username: 'private-user', password: 'private-password' };

    const reference = await vault.store(OWNER, { kind: 'owntracks_basic', value: secret });

    expect(reference).toMatch(/^vault:v1:/u);
    expect(client.row).not.toBeNull();
    expect(client.row?.keyVersion).toBe(7);
    expect(client.row?.wrappedKey.byteLength).toBe(32);
    expect(client.row?.ciphertext.toString('utf8')).not.toContain('private-user');
    expect(JSON.stringify(client.observedValues)).not.toContain('private-password');
    await expect(vault.read(OWNER, reference, 'owntracks_basic')).resolves.toEqual(secret);

    await expect(
      vault.read(
        { ...OWNER, accountId: connectorAccountId('20000000-0000-4000-8000-000000000002') },
        reference,
        'owntracks_basic',
      ),
    ).rejects.toBeInstanceOf(ConnectorCredentialError);
  });

  it('deploymentKeyRing_rejectsMissingOrMalformedKeyMaterial', () => {
    expect(() => DeploymentKeyRing.parse('')).toThrow();
    expect(() => DeploymentKeyRing.parse('1:not-a-key')).toThrow();
    expect(() => new DeploymentKeyRing([])).toThrow();
  });

  it('rotateRewrapAndRevoke_preserveOwnerScopingAndKeyVersioning', async () => {
    const client = new MemoryClient();
    const pool: SqlPoolPort = { connect: async () => client };
    const first = new DeploymentKeyRing([{ version: 1, key: new Uint8Array(32).fill(1) }]);
    const original = new PostgresConnectorCredentialVault(pool, first);
    const reference = await original.store(OWNER, {
      kind: 'owntracks_basic',
      value: { username: 'owner', password: 'old-password' },
    });

    await original.rotate(OWNER, reference, {
      kind: 'owntracks_basic',
      value: { username: 'owner', password: 'rotated-password' },
    });
    await expect(original.read(OWNER, reference, 'owntracks_basic')).resolves.toMatchObject({
      password: 'rotated-password',
    });

    const rotatedRing = new DeploymentKeyRing([
      { version: 1, key: new Uint8Array(32).fill(1) },
      { version: 2, key: new Uint8Array(32).fill(2) },
    ]);
    const rotated = new PostgresConnectorCredentialVault(pool, rotatedRing);
    await expect(rotated.rewrapToCurrentKey(OWNER, reference)).resolves.toBe(true);
    expect(client.row?.keyVersion).toBe(2);
    await expect(rotated.read(OWNER, reference, 'owntracks_basic')).resolves.toMatchObject({
      password: 'rotated-password',
    });

    await rotated.revoke(OWNER, reference);
    await expect(rotated.revoke(OWNER, reference)).resolves.toBeUndefined();
    await expect(rotated.read(OWNER, reference, 'owntracks_basic')).rejects.toThrow();
  });
});
