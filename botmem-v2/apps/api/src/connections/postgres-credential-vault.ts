import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GmailCredentialVaultPort, OAuthTokenSet } from '../connectors/gmail/index.js';
import type {
  OutlookCredentialVaultPort,
  OutlookOAuthTokenSet,
} from '../connectors/outlook/index.js';
import type {
  OwnTracksBasicCredentials,
  OwnTracksCredentialVaultPort,
} from '../connectors/owntracks/index.js';
import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import {
  credentialIdFromReference,
  DeploymentKeyRing,
  nextCredentialReference,
} from './key-ring.js';
import {
  ConnectorCredentialError,
  type ConnectionOwner,
  type ConnectorCredentialSecret,
  type ConnectorCredentialVault,
  type ConnectorSecretKind,
  type OwnedConnector,
} from './ports.js';

const oauthTokenSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    refreshToken: z.string().min(1).max(32_768),
    expiresAt: z.iso.datetime({ offset: true }),
    grantedScopes: z.array(z.string().min(1).max(2048)).min(1).max(32),
    tokenType: z.literal('Bearer'),
  })
  .strict();
const ownTracksCredentialsSchema = z
  .object({
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(4096),
  })
  .strict();

interface CredentialRow {
  readonly key_version: number;
  readonly secret_kind: ConnectorSecretKind;
  readonly wrap_nonce: Buffer;
  readonly wrapped_key: Buffer;
  readonly wrap_tag: Buffer;
  readonly payload_nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly payload_tag: Buffer;
}

interface Envelope {
  readonly keyVersion: number;
  readonly wrapNonce: Buffer;
  readonly wrappedKey: Buffer;
  readonly wrapTag: Buffer;
  readonly payloadNonce: Buffer;
  readonly ciphertext: Buffer;
  readonly payloadTag: Buffer;
}

/**
 * AES-256-GCM envelope vault. Each secret gets a random data-encryption key;
 * only that DEK is wrapped by the versioned deployment key. PostgreSQL receives
 * ciphertext and an opaque reference, never provider plaintext.
 */
export class PostgresConnectorCredentialVault implements ConnectorCredentialVault {
  constructor(
    private readonly pool: SqlPoolPort,
    private readonly keyRing: DeploymentKeyRing,
    private readonly runtimeRole: 'botmem_api' | 'botmem_worker' = 'botmem_api',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async store(owner: OwnedConnector, secret: ConnectorCredentialSecret): Promise<string> {
    assertSecretMatchesConnector(owner, secret.kind);
    const value = validateSecret(secret.kind, secret.value);
    const reference = nextCredentialReference();
    const envelope = encryptEnvelope(
      this.keyRing,
      owner,
      reference.id,
      secret.kind,
      Buffer.from(JSON.stringify(value), 'utf8'),
    );
    const timestamp = this.now();
    await this.transaction(owner, async (client) => {
      await client.query({
        text: `INSERT INTO botmem.connector_credential (
                 id, tenant_id, account_id, connector, secret_kind, key_version,
                 wrap_nonce, wrapped_key, wrap_tag, payload_nonce, ciphertext,
                 payload_tag, created_at, updated_at
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                 $7, $8, $9, $10, $11, $12, $13::timestamptz, $13::timestamptz
               )`,
        values: [
          reference.id,
          owner.tenantId,
          owner.accountId,
          owner.connector,
          secret.kind,
          envelope.keyVersion,
          envelope.wrapNonce,
          envelope.wrappedKey,
          envelope.wrapTag,
          envelope.payloadNonce,
          envelope.ciphertext,
          envelope.payloadTag,
          timestamp,
        ],
      });
    });
    return reference.ref;
  }

  async read(
    owner: OwnedConnector,
    credentialRef: string,
    expectedKind: ConnectorSecretKind,
  ): Promise<unknown> {
    assertSecretMatchesConnector(owner, expectedKind);
    const id = credentialIdFromReference(credentialRef);
    return this.transaction(owner, async (client) => {
      const row = await this.load(client, owner, id, false);
      if (!row || row.secret_kind !== expectedKind) throw new ConnectorCredentialError();
      try {
        const plaintext = decryptEnvelope(this.keyRing, owner, id, row);
        return validateSecret(expectedKind, JSON.parse(plaintext.toString('utf8')));
      } catch {
        throw new ConnectorCredentialError();
      }
    });
  }

  async rotate(
    owner: OwnedConnector,
    credentialRef: string,
    secret: ConnectorCredentialSecret,
  ): Promise<void> {
    assertSecretMatchesConnector(owner, secret.kind);
    const id = credentialIdFromReference(credentialRef);
    const value = validateSecret(secret.kind, secret.value);
    const envelope = encryptEnvelope(
      this.keyRing,
      owner,
      id,
      secret.kind,
      Buffer.from(JSON.stringify(value), 'utf8'),
    );
    await this.transaction(owner, async (client) => {
      const updated = await client.query({
        text: `UPDATE botmem.connector_credential
                  SET key_version = $6,
                      wrap_nonce = $7,
                      wrapped_key = $8,
                      wrap_tag = $9,
                      payload_nonce = $10,
                      ciphertext = $11,
                      payload_tag = $12,
                      updated_at = $13::timestamptz
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND connector = $4 AND secret_kind = $5
                  AND revoked_at IS NULL`,
        values: [
          owner.tenantId,
          owner.accountId,
          id,
          owner.connector,
          secret.kind,
          envelope.keyVersion,
          envelope.wrapNonce,
          envelope.wrappedKey,
          envelope.wrapTag,
          envelope.payloadNonce,
          envelope.ciphertext,
          envelope.payloadTag,
          this.now(),
        ],
      });
      if (updated.rowCount !== 1) throw new ConnectorCredentialError();
    });
  }

  async rewrapToCurrentKey(owner: OwnedConnector, credentialRef: string): Promise<boolean> {
    const id = credentialIdFromReference(credentialRef);
    return this.transaction(owner, async (client) => {
      const row = await this.load(client, owner, id, true);
      if (!row) throw new ConnectorCredentialError();
      if (row.key_version === this.keyRing.currentVersion) return false;
      let dataKey: Buffer;
      try {
        dataKey = unwrapDataKey(this.keyRing, owner, id, row.secret_kind, row);
      } catch {
        throw new ConnectorCredentialError();
      }
      const wrapped = wrapDataKey(this.keyRing, owner, id, row.secret_kind, dataKey);
      const result = await client.query({
        text: `UPDATE botmem.connector_credential
                  SET key_version = $4, wrap_nonce = $5, wrapped_key = $6,
                      wrap_tag = $7, updated_at = $8::timestamptz
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND revoked_at IS NULL`,
        values: [
          owner.tenantId,
          owner.accountId,
          id,
          wrapped.keyVersion,
          wrapped.wrapNonce,
          wrapped.wrappedKey,
          wrapped.wrapTag,
          this.now(),
        ],
      });
      if (result.rowCount !== 1) throw new ConnectorCredentialError();
      return true;
    });
  }

  async revoke(owner: OwnedConnector, credentialRef: string): Promise<void> {
    const id = credentialIdFromReference(credentialRef);
    await this.transaction(owner, async (client) => {
      const result = await client.query({
        text: `UPDATE botmem.connector_credential
                  SET revoked_at = $4::timestamptz, updated_at = $4::timestamptz
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND revoked_at IS NULL`,
        values: [owner.tenantId, owner.accountId, id, this.now()],
      });
      if (result.rowCount === 1) return;
      const existing = await client.query({
        text: `SELECT 1 FROM botmem.connector_credential
                WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                  AND id = $3::uuid AND connector = $4 AND revoked_at IS NOT NULL`,
        values: [owner.tenantId, owner.accountId, id, owner.connector],
      });
      if (existing.rowCount !== 1) throw new ConnectorCredentialError();
    });
  }

  private async load(
    client: SqlClientPort,
    owner: OwnedConnector,
    id: string,
    lock: boolean,
  ): Promise<CredentialRow | null> {
    const result = await client.query<CredentialRow>({
      text: `SELECT key_version, secret_kind, wrap_nonce, wrapped_key, wrap_tag,
                    payload_nonce, ciphertext, payload_tag
               FROM botmem.connector_credential
              WHERE tenant_id = $1::uuid AND account_id = $2::uuid
                AND id = $3::uuid AND connector = $4 AND revoked_at IS NULL
              ${lock ? 'FOR UPDATE' : ''}`,
      values: [owner.tenantId, owner.accountId, id, owner.connector],
    });
    return result.rows[0] ?? null;
  }

  private async transaction<Result>(
    owner: ConnectionOwner,
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await client.query({ text: `SET LOCAL ROLE ${this.runtimeRole}` });
      await client.query({
        text: `SELECT set_config('botmem.tenant_id', $1, true),
                      set_config('botmem.connector_account_id', $2, true)`,
        values: [owner.tenantId, owner.accountId],
      });
      const result = await operation(client);
      await client.query({ text: 'COMMIT' });
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class GmailCredentialVaultAdapter implements GmailCredentialVaultPort {
  constructor(private readonly vault: ConnectorCredentialVault) {}
  store(owner: ConnectionOwner, tokens: OAuthTokenSet): Promise<string> {
    return this.vault.store(
      { ...owner, connector: 'gmail' },
      { kind: 'gmail_oauth', value: tokens },
    );
  }
  async read(owner: ConnectionOwner, ref: string): Promise<OAuthTokenSet> {
    return (await this.vault.read(
      { ...owner, connector: 'gmail' },
      ref,
      'gmail_oauth',
    )) as OAuthTokenSet;
  }
  rotate(owner: ConnectionOwner, ref: string, tokens: OAuthTokenSet): Promise<void> {
    return this.vault.rotate({ ...owner, connector: 'gmail' }, ref, {
      kind: 'gmail_oauth',
      value: tokens,
    });
  }
  revoke(owner: ConnectionOwner, ref: string): Promise<void> {
    return this.vault.revoke({ ...owner, connector: 'gmail' }, ref);
  }
}

export class OutlookCredentialVaultAdapter implements OutlookCredentialVaultPort {
  constructor(private readonly vault: ConnectorCredentialVault) {}
  store(owner: ConnectionOwner, tokens: OutlookOAuthTokenSet): Promise<string> {
    return this.vault.store(
      { ...owner, connector: 'outlook' },
      { kind: 'outlook_oauth', value: tokens },
    );
  }
  async read(owner: ConnectionOwner, ref: string): Promise<OutlookOAuthTokenSet> {
    return (await this.vault.read(
      { ...owner, connector: 'outlook' },
      ref,
      'outlook_oauth',
    )) as OutlookOAuthTokenSet;
  }
  rotate(owner: ConnectionOwner, ref: string, tokens: OutlookOAuthTokenSet): Promise<void> {
    return this.vault.rotate({ ...owner, connector: 'outlook' }, ref, {
      kind: 'outlook_oauth',
      value: tokens,
    });
  }
  revoke(owner: ConnectionOwner, ref: string): Promise<void> {
    return this.vault.revoke({ ...owner, connector: 'outlook' }, ref);
  }
}

export class OwnTracksCredentialVaultAdapter implements OwnTracksCredentialVaultPort {
  constructor(private readonly vault: ConnectorCredentialVault) {}
  async read(owner: ConnectionOwner, ref: string): Promise<OwnTracksBasicCredentials> {
    return (await this.vault.read(
      { ...owner, connector: 'owntracks' },
      ref,
      'owntracks_basic',
    )) as OwnTracksBasicCredentials;
  }
  revoke(owner: ConnectionOwner, ref: string): Promise<void> {
    return this.vault.revoke({ ...owner, connector: 'owntracks' }, ref);
  }
}

function assertSecretMatchesConnector(owner: OwnedConnector, kind: ConnectorSecretKind): void {
  if (
    (owner.connector === 'gmail' && kind !== 'gmail_oauth') ||
    (owner.connector === 'outlook' && kind !== 'outlook_oauth') ||
    (owner.connector === 'owntracks' && kind !== 'owntracks_basic')
  ) {
    throw new ConnectorCredentialError();
  }
}

function validateSecret(kind: ConnectorSecretKind, value: unknown): unknown {
  return kind === 'owntracks_basic'
    ? ownTracksCredentialsSchema.parse(value)
    : oauthTokenSchema.parse(value);
}

function envelopeAad(
  purpose: 'payload' | 'wrap',
  owner: OwnedConnector,
  id: string,
  kind: ConnectorSecretKind,
  keyVersion?: number,
): Buffer {
  return Buffer.from(
    [
      'botmem-v2',
      'connector-credential',
      'v1',
      purpose,
      owner.tenantId,
      owner.accountId,
      owner.connector,
      kind,
      id,
      keyVersion ?? '-',
    ].join(':'),
    'utf8',
  );
}

function encryptEnvelope(
  keyRing: DeploymentKeyRing,
  owner: OwnedConnector,
  id: string,
  kind: ConnectorSecretKind,
  plaintext: Buffer,
): Envelope {
  const dataKey = randomBytes(32);
  const payloadNonce = randomBytes(12);
  const payloadCipher = createCipheriv('aes-256-gcm', dataKey, payloadNonce);
  payloadCipher.setAAD(envelopeAad('payload', owner, id, kind));
  const ciphertext = Buffer.concat([payloadCipher.update(plaintext), payloadCipher.final()]);
  const wrapped = wrapDataKey(keyRing, owner, id, kind, dataKey);
  return {
    ...wrapped,
    payloadNonce,
    ciphertext,
    payloadTag: payloadCipher.getAuthTag(),
  };
}

function wrapDataKey(
  keyRing: DeploymentKeyRing,
  owner: OwnedConnector,
  id: string,
  kind: ConnectorSecretKind,
  dataKey: Buffer,
): Pick<Envelope, 'keyVersion' | 'wrapNonce' | 'wrappedKey' | 'wrapTag'> {
  const keyVersion = keyRing.currentVersion;
  const wrapNonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyRing.current(), wrapNonce);
  cipher.setAAD(envelopeAad('wrap', owner, id, kind, keyVersion));
  const wrappedKey = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { keyVersion, wrapNonce, wrappedKey, wrapTag: cipher.getAuthTag() };
}

function unwrapDataKey(
  keyRing: DeploymentKeyRing,
  owner: OwnedConnector,
  id: string,
  kind: ConnectorSecretKind,
  row: CredentialRow,
): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyRing.require(Number(row.key_version)),
    row.wrap_nonce,
  );
  decipher.setAAD(envelopeAad('wrap', owner, id, kind, Number(row.key_version)));
  decipher.setAuthTag(row.wrap_tag);
  const dataKey = Buffer.concat([decipher.update(row.wrapped_key), decipher.final()]);
  if (dataKey.byteLength !== 32) throw new Error('invalid credential data key');
  return dataKey;
}

function decryptEnvelope(
  keyRing: DeploymentKeyRing,
  owner: OwnedConnector,
  id: string,
  row: CredentialRow,
): Buffer {
  const dataKey = unwrapDataKey(keyRing, owner, id, row.secret_kind, row);
  const decipher = createDecipheriv('aes-256-gcm', dataKey, row.payload_nonce);
  decipher.setAAD(envelopeAad('payload', owner, id, row.secret_kind));
  decipher.setAuthTag(row.payload_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}
