import type { Connector } from '@botmem-v2/contracts';

export type LocalConnector = Extract<Connector, 'imessage' | 'whatsapp'>;
export type DeviceStatus = 'active' | 'revoked';

export interface DeviceOwner {
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface DeviceSnapshot extends DeviceOwner {
  readonly deviceId: string;
  readonly displayName: string;
  readonly keyId: string;
  readonly publicKeyBase64Url: string;
  readonly connectors: readonly LocalConnector[];
  readonly status: DeviceStatus;
  readonly credentialVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
  readonly revocationReason?: 'user_revoked' | 'credential_rotated' | 'device_deleted';
}

export class DeviceAggregate {
  private constructor(private snapshot: DeviceSnapshot) {}

  static pair(
    input: Omit<DeviceSnapshot, 'status' | 'credentialVersion' | 'createdAt' | 'updatedAt'>,
    now: string,
  ): DeviceAggregate {
    assertDeviceOwner(input);
    validateUuid('deviceId', input.deviceId);
    validateBounded('displayName', input.displayName, 1, 128);
    validateKey(input.keyId, input.publicKeyBase64Url);
    validateConnectors(input.connectors);
    validateTimestamp(now);
    return new DeviceAggregate({
      ...input,
      connectors: [...new Set(input.connectors)].sort(),
      status: 'active',
      credentialVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(snapshot: DeviceSnapshot): DeviceAggregate {
    assertDeviceOwner(snapshot);
    validateUuid('deviceId', snapshot.deviceId);
    validateBounded('displayName', snapshot.displayName, 1, 128);
    validateKey(snapshot.keyId, snapshot.publicKeyBase64Url);
    validateConnectors(snapshot.connectors);
    if (!Number.isSafeInteger(snapshot.credentialVersion) || snapshot.credentialVersion < 1) {
      throw new DeviceInvariantError('credentialVersion must be a positive safe integer');
    }
    if (snapshot.status === 'active' && snapshot.revokedAt) {
      throw new DeviceInvariantError('active device cannot have revokedAt');
    }
    if (snapshot.status === 'revoked' && (!snapshot.revokedAt || !snapshot.revocationReason)) {
      throw new DeviceInvariantError('revoked device requires revokedAt and revocationReason');
    }
    return new DeviceAggregate({ ...snapshot, connectors: [...snapshot.connectors] });
  }

  view(): DeviceSnapshot {
    return { ...this.snapshot, connectors: [...this.snapshot.connectors] };
  }

  assertOwnedBy(owner: DeviceOwner): void {
    if (
      this.snapshot.tenantId !== owner.tenantId ||
      this.snapshot.workspaceId !== owner.workspaceId
    ) {
      throw new DeviceOwnershipError();
    }
  }

  assertAuthenticatable(keyId: string): void {
    if (this.snapshot.status !== 'active') throw new DeviceRevokedError();
    if (this.snapshot.keyId !== keyId) throw new DeviceKeyMismatchError();
  }

  rotateIdentity(keyId: string, publicKeyBase64Url: string, now: string): void {
    if (this.snapshot.status !== 'active') throw new DeviceRevokedError();
    validateKey(keyId, publicKeyBase64Url);
    validateTimestamp(now);
    this.snapshot = {
      ...this.snapshot,
      keyId,
      publicKeyBase64Url,
      credentialVersion: this.snapshot.credentialVersion + 1,
      updatedAt: now,
    };
  }

  revoke(reason: 'user_revoked' | 'credential_rotated' | 'device_deleted', now: string): void {
    validateTimestamp(now);
    if (this.snapshot.status === 'revoked') return;
    this.snapshot = {
      ...this.snapshot,
      status: 'revoked',
      credentialVersion: this.snapshot.credentialVersion + 1,
      updatedAt: now,
      revokedAt: now,
      revocationReason: reason,
    };
  }
}

export function assertDeviceOwner(owner: DeviceOwner): void {
  validateUuid('tenantId', owner.tenantId);
  validateUuid('workspaceId', owner.workspaceId);
}

function validateKey(keyId: string, publicKeyBase64Url: string): void {
  validateBounded('keyId', keyId, 1, 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKeyBase64Url)) {
    throw new DeviceInvariantError('Ed25519 public key must be 32-byte base64url');
  }
}

function validateConnectors(connectors: readonly LocalConnector[]): void {
  if (
    connectors.length < 1 ||
    connectors.length > 2 ||
    connectors.some((connector) => connector !== 'imessage' && connector !== 'whatsapp')
  ) {
    throw new DeviceInvariantError('device connectors must contain iMessage or WhatsApp');
  }
}

function validateUuid(field: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DeviceInvariantError(`${field} must be a UUID`);
  }
}

function validateBounded(field: string, value: string, minimum: number, maximum: number): void {
  if (value.trim() !== value || value.length < minimum || value.length > maximum) {
    throw new DeviceInvariantError(`${field} must contain ${minimum}..=${maximum} characters`);
  }
}

function validateTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new DeviceInvariantError('timestamp is invalid');
}

export class DeviceInvariantError extends Error {}
export class DeviceOwnershipError extends Error {}
export class DeviceRevokedError extends Error {}
export class DeviceKeyMismatchError extends Error {}
