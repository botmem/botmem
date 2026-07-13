import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GmailCryptoPort } from '../connectors/gmail/index.js';
import type { OutlookCryptoPort } from '../connectors/outlook/index.js';

export interface DeploymentKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export class DeploymentKeyRing {
  private readonly keys: ReadonlyMap<number, Uint8Array>;
  readonly currentVersion: number;

  constructor(keys: readonly DeploymentKey[]) {
    if (keys.length === 0) throw new Error('at least one deployment encryption key is required');
    const normalized = new Map<number, Uint8Array>();
    for (const entry of keys) {
      if (!Number.isInteger(entry.version) || entry.version <= 0 || entry.key.byteLength !== 32) {
        throw new Error('deployment keys require a positive version and exactly 32 bytes');
      }
      if (normalized.has(entry.version)) throw new Error('deployment key versions must be unique');
      normalized.set(entry.version, new Uint8Array(entry.key));
    }
    this.keys = normalized;
    this.currentVersion = Math.max(...normalized.keys());
  }

  current(): Uint8Array {
    return this.require(this.currentVersion);
  }

  require(version: number): Uint8Array {
    const key = this.keys.get(version);
    if (!key) throw new Error('credential encryption key version is unavailable');
    return new Uint8Array(key);
  }

  static parse(serialized: string): DeploymentKeyRing {
    if (!serialized.trim()) throw new Error('CONNECTOR_VAULT_KEYS is required');
    return new DeploymentKeyRing(
      serialized.split(',').map((entry) => {
        const match = /^(\d+):([A-Za-z0-9_-]{43})$/u.exec(entry.trim());
        if (!match) throw new Error('CONNECTOR_VAULT_KEYS must be version:base64url entries');
        const key = Buffer.from(match[2]!, 'base64url');
        if (key.byteLength !== 32) throw new Error('connector vault key must decode to 32 bytes');
        return { version: Number(match[1]), key: new Uint8Array(key) };
      }),
    );
  }
}

export class NodeConnectorCrypto implements GmailCryptoPort, OutlookCryptoPort {
  constructor(private readonly keyRing: DeploymentKeyRing) {}

  async randomUrlSafe(byteLength: number): Promise<string> {
    if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
      throw new RangeError('random byte length is outside the connector security policy');
    }
    return randomBytes(byteLength).toString('base64url');
  }

  async sha256Base64Url(value: string): Promise<string> {
    return createHash('sha256').update(value, 'utf8').digest('base64url');
  }

  async sha256Hex(value: string): Promise<string> {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  async sealEphemeral(value: string): Promise<string> {
    const version = this.keyRing.currentVersion;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyRing.current(), nonce);
    cipher.setAAD(Buffer.from('botmem-v2:oauth-state:v1', 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'oauthseal',
      'v1',
      String(version),
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join(':');
  }

  async openEphemeral(sealedValue: string): Promise<string> {
    const parts = sealedValue.split(':');
    if (parts.length !== 6 || parts[0] !== 'oauthseal' || parts[1] !== 'v1') {
      throw new Error('invalid OAuth state seal');
    }
    const version = Number(parts[2]);
    const nonce = decode(parts[3]!, 12);
    const tag = decode(parts[5]!, 16);
    const ciphertext = decode(parts[4]!, undefined, 8192);
    const decipher = createDecipheriv('aes-256-gcm', this.keyRing.require(version), nonce);
    decipher.setAAD(Buffer.from('botmem-v2:oauth-state:v1', 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

export function nextCredentialReference(): { readonly id: string; readonly ref: string } {
  const id = randomUUID();
  return { id, ref: `vault:v1:${id}` };
}

export function credentialIdFromReference(value: string): string {
  const match =
    /^vault:v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
      value,
    );
  if (!match) throw new Error('invalid connector credential reference');
  return match[1]!.toLowerCase();
}

function decode(value: string, exact?: number, maximum = exact): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid sealed value encoding');
  const bytes = Buffer.from(value, 'base64url');
  if (
    (exact !== undefined && bytes.byteLength !== exact) ||
    (maximum && bytes.byteLength > maximum)
  ) {
    throw new Error('invalid sealed value length');
  }
  return bytes;
}
