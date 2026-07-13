import type { DeviceAvailability } from '@botmem-v2/search-domain';
import type { DeviceOwner, DeviceSnapshot, LocalConnector } from './domain.js';

export interface ClockPort {
  nowMs(): number;
}

export interface SecretGeneratorPort {
  bytes(length: number): Uint8Array;
  uuid(): string;
}

export interface DigestPort {
  sha256(value: Uint8Array): Promise<string>;
}

export interface PairingGrant extends DeviceOwner {
  readonly grantId: string;
  readonly codeHash: string;
  readonly expiresAt: string;
}

export interface PairingCodeRepositoryPort {
  save(grant: PairingGrant): Promise<void>;
  /** Atomically returns only an unconsumed, unexpired owner-matching grant. */
  consume(input: {
    codeHash: string;
    tenantId: string;
    workspaceId: string;
    consumedAt: string;
  }): Promise<PairingGrant | undefined>;
}

export interface ChallengeRecord extends DeviceOwner {
  readonly challengeId: string;
  readonly deviceId: string;
  readonly keyId: string;
  readonly clientNonceHash: string;
  readonly serverNonceHash: string;
  readonly expiresAt: string;
}

export interface ChallengeRepositoryPort {
  save(challenge: ChallengeRecord): Promise<void>;
  /** Atomically returns only an unconsumed, unexpired owner-matching challenge. */
  consume(input: {
    tenantId: string;
    workspaceId: string;
    deviceId: string;
    keyId: string;
    clientNonceHash: string;
    serverNonceHash: string;
    consumedAt: string;
  }): Promise<ChallengeRecord | undefined>;
}

export interface DeviceRegistryPort {
  create(device: DeviceSnapshot): Promise<void>;
  get(owner: DeviceOwner, deviceId: string): Promise<DeviceSnapshot | undefined>;
  listForWorkspace(workspaceId: string): Promise<readonly DeviceSnapshot[]>;
  save(device: DeviceSnapshot, expectedCredentialVersion: number): Promise<void>;
}

export interface RateLimitPort {
  consume(input: { key: string; limit: number; windowMs: number; nowMs: number }): Promise<boolean>;
}

export interface SignatureVerifierPort {
  verifyEd25519(input: {
    publicKeyBase64Url: string;
    message: Uint8Array;
    signatureBase64Url: string;
  }): Promise<boolean>;
}

export interface DeviceCredential {
  readonly value: string;
  readonly generation: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly version: number;
}

export interface CredentialLifecyclePort {
  issue(device: DeviceSnapshot): Promise<DeviceCredential>;
  rotate(device: DeviceSnapshot): Promise<DeviceCredential>;
  revoke(device: DeviceSnapshot): Promise<void>;
}

export interface DevicePresence {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly ownerReplicaId: string;
  readonly connectors: readonly LocalConnector[];
  readonly availability: DeviceAvailability;
  readonly reasonCode?: string;
  readonly clientVersion?: string;
  readonly lastSeenAtMs?: number;
  readonly sessionGeneration?: number;
  readonly expiresAtMs: number;
}

/** Redis-compatible metadata port. Implementations store no query or result payload. */
export interface PresenceDirectoryPort {
  upsert(presence: DevicePresence): Promise<void>;
  removeIfCurrent(workspaceId: string, deviceId: string, sessionId: string): Promise<void>;
  get(workspaceId: string, deviceId: string): Promise<DevicePresence | undefined>;
  list(workspaceId: string): Promise<readonly DevicePresence[]>;
}

/**
 * Routes one bounded RPC to the replica owning an outbound WebSocket. The
 * frame must stay in transit only; implementations must not persist or log it.
 */
export interface ReplicaDeviceRpcPort {
  request(presence: DevicePresence, frame: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  cancel(presence: DevicePresence, frame: Uint8Array): Promise<void>;
}

/** A live socket initiated by the signed client; the API never dials the Mac. */
export interface OutboundDeviceSessionPort {
  readonly sessionId: string;
  readonly deviceId: string;
  request(frame: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  send(frame: Uint8Array): Promise<void>;
}

export interface LocalOutboundSessionRegistryPort {
  get(sessionId: string): OutboundDeviceSessionPort | undefined;
}

/** Ephemeral inter-replica request bus; implementations must disable payload persistence. */
export interface ReplicaRequestBusPort {
  request(
    ownerReplicaId: string,
    sessionId: string,
    frame: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  send(ownerReplicaId: string, sessionId: string, frame: Uint8Array): Promise<void>;
}
