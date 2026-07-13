import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type { DeviceOwner, DeviceSnapshot, LocalConnector } from './domain.js';
import type {
  ChallengeRecord,
  ChallengeRepositoryPort,
  ClockPort,
  CredentialLifecyclePort,
  DeviceCredential,
  DeviceRegistryPort,
  PairingCodeRepositoryPort,
  PairingGrant,
  SecretGeneratorPort,
} from './ports.js';

interface DeviceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly display_name: string;
  readonly key_id: string;
  readonly public_key: Uint8Array;
  readonly connectors: readonly string[];
  readonly status: 'active' | 'revoked';
  readonly credential_version: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly revocation_reason: DeviceSnapshot['revocationReason'] | null;
}

interface PairingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly code_hash: Uint8Array;
  readonly expires_at: Date | string;
}

interface ChallengeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly device_id: string;
  readonly key_id: string;
  readonly client_nonce_hash: Uint8Array;
  readonly server_nonce_hash: Uint8Array;
  readonly expires_at: Date | string;
}

interface CredentialGenerationRow {
  readonly generation: string | number;
}

/** PostgreSQL adapter for RLS-scoped device identity and single-use grants. */
export class PostgresDeviceSecurityRepository
  implements DeviceRegistryPort, PairingCodeRepositoryPort, ChallengeRepositoryPort
{
  constructor(private readonly pool: SqlPoolPort) {}

  async create(device: DeviceSnapshot): Promise<void> {
    await ownerTransaction(this.pool, device, async (client) => {
      await client.query({
        text: `INSERT INTO botmem.device_registry (
          id, tenant_id, workspace_id, display_name, key_id, public_key,
          connectors, status, credential_version, created_at, updated_at,
          revoked_at, revocation_reason
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, decode($6, 'hex'), $7::text[],
          $8, $9::bigint, $10::timestamptz, $11::timestamptz,
          $12::timestamptz, $13
        )`,
        values: [
          device.deviceId,
          device.tenantId,
          device.workspaceId,
          device.displayName,
          device.keyId,
          Buffer.from(device.publicKeyBase64Url, 'base64url').toString('hex'),
          [...device.connectors],
          device.status,
          device.credentialVersion,
          device.createdAt,
          device.updatedAt,
          device.revokedAt ?? null,
          device.revocationReason ?? null,
        ],
      });
    });
  }

  async get(owner: DeviceOwner, deviceId: string): Promise<DeviceSnapshot | undefined> {
    return ownerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<DeviceRow>({
        text: `${DEVICE_SELECT} WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND id = $3::uuid`,
        values: [owner.tenantId, owner.workspaceId, deviceId],
      });
      return result.rows[0] ? toDevice(result.rows[0]) : undefined;
    });
  }

  async listForWorkspace(workspaceId: string): Promise<readonly DeviceSnapshot[]> {
    const owner = { tenantId: workspaceId, workspaceId };
    return ownerTransaction(this.pool, owner, async (client) => {
      const result = await client.query<DeviceRow>({
        text: `${DEVICE_SELECT} WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid ORDER BY id LIMIT 64`,
        values: [workspaceId, workspaceId],
      });
      return result.rows.map(toDevice);
    });
  }

  save(device: DeviceSnapshot, expectedCredentialVersion: number): Promise<void>;
  save(grant: PairingGrant): Promise<void>;
  save(challenge: ChallengeRecord): Promise<void>;
  async save(
    record: DeviceSnapshot | PairingGrant | ChallengeRecord,
    expectedCredentialVersion?: number,
  ): Promise<void> {
    if ('credentialVersion' in record) {
      if (expectedCredentialVersion === undefined) {
        throw new TypeError('expected credential version is required');
      }
      await this.saveDevice(record, expectedCredentialVersion);
      return;
    }
    if ('challengeId' in record) {
      await this.saveChallenge(record);
      return;
    }
    await this.savePairingGrant(record);
  }

  private async saveDevice(
    device: DeviceSnapshot,
    expectedCredentialVersion: number,
  ): Promise<void> {
    await ownerTransaction(this.pool, device, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.device_registry SET
          display_name = $4, key_id = $5, public_key = decode($6, 'hex'),
          connectors = $7::text[], status = $8, credential_version = $9::bigint,
          updated_at = $10::timestamptz, revoked_at = $11::timestamptz,
          revocation_reason = $12
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND id = $3::uuid
          AND credential_version = $13::bigint`,
        values: [
          device.tenantId,
          device.workspaceId,
          device.deviceId,
          device.displayName,
          device.keyId,
          Buffer.from(device.publicKeyBase64Url, 'base64url').toString('hex'),
          [...device.connectors],
          device.status,
          device.credentialVersion,
          device.updatedAt,
          device.revokedAt ?? null,
          device.revocationReason ?? null,
          expectedCredentialVersion,
        ],
      });
      if (result.rowCount !== 1) throw new DeviceOptimisticLockError();
    });
  }

  private async saveChallenge(record: ChallengeRecord): Promise<void> {
    await ownerTransaction(this.pool, record, async (client) => {
      await client.query({
        text: `INSERT INTO botmem.device_auth_challenge (
            id, tenant_id, workspace_id, device_id, key_id, client_nonce_hash,
            server_nonce_hash, expires_at, created_at
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
            decode($6, 'hex'), decode($7, 'hex'), $8::timestamptz,
            transaction_timestamp()
          )`,
        values: [
          record.challengeId,
          record.tenantId,
          record.workspaceId,
          record.deviceId,
          record.keyId,
          record.clientNonceHash,
          record.serverNonceHash,
          record.expiresAt,
        ],
      });
    });
  }

  private async savePairingGrant(record: PairingGrant): Promise<void> {
    await ownerTransaction(this.pool, record, async (client) => {
      await client.query({
        text: `INSERT INTO botmem.device_pairing_grant (
          id, tenant_id, workspace_id, code_hash, expires_at, created_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, decode($4, 'hex'),
          $5::timestamptz, transaction_timestamp()
        )`,
        values: [
          record.grantId,
          record.tenantId,
          record.workspaceId,
          record.codeHash,
          record.expiresAt,
        ],
      });
    });
  }

  consume(input: {
    codeHash: string;
    tenantId: string;
    workspaceId: string;
    consumedAt: string;
  }): Promise<PairingGrant | undefined>;
  consume(input: {
    tenantId: string;
    workspaceId: string;
    deviceId: string;
    keyId: string;
    clientNonceHash: string;
    serverNonceHash: string;
    consumedAt: string;
  }): Promise<ChallengeRecord | undefined>;
  async consume(
    input:
      | {
          codeHash: string;
          tenantId: string;
          workspaceId: string;
          consumedAt: string;
        }
      | {
          tenantId: string;
          workspaceId: string;
          deviceId: string;
          keyId: string;
          clientNonceHash: string;
          serverNonceHash: string;
          consumedAt: string;
        },
  ): Promise<PairingGrant | ChallengeRecord | undefined> {
    if ('codeHash' in input) {
      return ownerTransaction(this.pool, input, async (client) => {
        const result = await client.query<PairingRow>({
          text: `UPDATE botmem.device_pairing_grant SET consumed_at = statement_timestamp()
            WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
              AND code_hash = decode($3, 'hex') AND consumed_at IS NULL
              AND expires_at > statement_timestamp()
            RETURNING id, tenant_id, workspace_id, code_hash, expires_at`,
          values: [input.tenantId, input.workspaceId, input.codeHash],
        });
        return result.rows[0] ? toPairingGrant(result.rows[0]) : undefined;
      });
    }
    return ownerTransaction(this.pool, input, async (client) => {
      const result = await client.query<ChallengeRow>({
        text: `UPDATE botmem.device_auth_challenge SET consumed_at = statement_timestamp()
          WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
            AND device_id = $3::uuid AND key_id = $4
            AND client_nonce_hash = decode($5, 'hex')
            AND server_nonce_hash = decode($6, 'hex')
          AND consumed_at IS NULL AND expires_at > statement_timestamp()
          RETURNING id, tenant_id, workspace_id, device_id, key_id,
            client_nonce_hash, server_nonce_hash, expires_at`,
        values: [
          input.tenantId,
          input.workspaceId,
          input.deviceId,
          input.keyId,
          input.clientNonceHash,
          input.serverNonceHash,
        ],
      });
      return result.rows[0] ? toChallenge(result.rows[0]) : undefined;
    });
  }
}

/** Issues one active, bounded device session credential per device. */
export class PostgresDeviceCredentialLifecycle implements CredentialLifecyclePort {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly ids: SecretGeneratorPort,
    private readonly clock: ClockPort,
    private readonly lifetimeMs = 15 * 60_000,
  ) {
    if (lifetimeMs < 60_000 || lifetimeMs > 24 * 60 * 60_000) {
      throw new RangeError('device credential lifetime must be between 1 minute and 24 hours');
    }
  }

  issue(device: DeviceSnapshot): Promise<DeviceCredential> {
    return this.replace(device);
  }

  rotate(device: DeviceSnapshot): Promise<DeviceCredential> {
    return this.replace(device);
  }

  async revoke(device: DeviceSnapshot): Promise<void> {
    const revokedAt = new Date(this.clock.nowMs()).toISOString();
    await ownerTransaction(this.pool, device, async (client) => {
      await client.query({
        text: `UPDATE botmem.device_session_credential
          SET revoked_at = $4::timestamptz, revocation_reason = 'device_revoked'
          WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
            AND device_id = $3::uuid AND revoked_at IS NULL`,
        values: [device.tenantId, device.workspaceId, device.deviceId, revokedAt],
      });
    });
  }

  private async replace(device: DeviceSnapshot): Promise<DeviceCredential> {
    const value = this.ids.uuid();
    const createdAt = new Date(this.clock.nowMs()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + this.lifetimeMs).toISOString();
    const generation = await ownerTransaction(this.pool, device, async (client) => {
      await client.query({
        text: `UPDATE botmem.device_session_credential
          SET revoked_at = $4::timestamptz, revocation_reason = 'replaced'
          WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
            AND device_id = $3::uuid AND revoked_at IS NULL`,
        values: [device.tenantId, device.workspaceId, device.deviceId, createdAt],
      });
      const inserted = await client.query<CredentialGenerationRow>({
        text: `INSERT INTO botmem.device_session_credential (
          id, tenant_id, workspace_id, device_id, credential_version,
          created_at, expires_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint,
          $6::timestamptz, $7::timestamptz
        ) RETURNING generation`,
        values: [
          value,
          device.tenantId,
          device.workspaceId,
          device.deviceId,
          device.credentialVersion,
          createdAt,
          expiresAt,
        ],
      });
      const generated = Number(inserted.rows[0]?.generation);
      if (!Number.isSafeInteger(generated) || generated < 1) {
        throw new DeviceCredentialGenerationError();
      }
      return generated;
    });
    return {
      value,
      generation,
      issuedAt: createdAt,
      expiresAt,
      version: device.credentialVersion,
    };
  }
}

const DEVICE_SELECT = `SELECT
  id, tenant_id, workspace_id, display_name, key_id, public_key, connectors,
  status, credential_version, created_at, updated_at, revoked_at, revocation_reason
  FROM botmem.device_registry`;

async function ownerTransaction<T>(
  pool: SqlPoolPort,
  owner: DeviceOwner,
  operation: (client: SqlClientPort) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let completed = false;
  try {
    await client.query({ text: 'BEGIN' });
    await client.query({ text: 'SET LOCAL ROLE botmem_api' });
    await client.query({
      text: `SELECT
        set_config('botmem.tenant_id', $1, true),
        set_config('botmem.workspace_id', $2, true)`,
      values: [owner.tenantId, owner.workspaceId],
    });
    const result = await operation(client);
    await client.query({ text: 'COMMIT' });
    completed = true;
    return result;
  } finally {
    if (!completed) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
    client.release(!completed);
  }
}

function toDevice(row: DeviceRow): DeviceSnapshot {
  const connectors = row.connectors.filter(
    (connector): connector is LocalConnector =>
      connector === 'imessage' || connector === 'whatsapp',
  );
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    deviceId: row.id,
    displayName: row.display_name,
    keyId: row.key_id,
    publicKeyBase64Url: Buffer.from(row.public_key).toString('base64url'),
    connectors,
    status: row.status,
    credentialVersion: Number(row.credential_version),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at) } : {}),
    ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}),
  };
}

function toPairingGrant(row: PairingRow): PairingGrant {
  return {
    grantId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    codeHash: Buffer.from(row.code_hash).toString('hex'),
    expiresAt: timestamp(row.expires_at),
  };
}

function toChallenge(row: ChallengeRow): ChallengeRecord {
  return {
    challengeId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    keyId: row.key_id,
    clientNonceHash: Buffer.from(row.client_nonce_hash).toString('hex'),
    serverNonceHash: Buffer.from(row.server_nonce_hash).toString('hex'),
    expiresAt: timestamp(row.expires_at),
  };
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export class DeviceOptimisticLockError extends Error {}
export class DeviceCredentialGenerationError extends Error {}
