import { DeviceAggregate, DeviceOwnershipError, type DeviceOwner } from './domain.js';
import { encodeBase64Url } from './crypto.js';
import type {
  ChallengeRepositoryPort,
  ClockPort,
  CredentialLifecyclePort,
  DeviceCredential,
  DeviceRegistryPort,
  DigestPort,
  RateLimitPort,
  SecretGeneratorPort,
  SignatureVerifierPort,
} from './ports.js';
import { DeviceRateLimitedError } from './pairing-service.js';

const encoder = new TextEncoder();

export class DeviceAuthenticationService {
  constructor(
    private readonly challenges: ChallengeRepositoryPort,
    private readonly devices: DeviceRegistryPort,
    private readonly credentials: CredentialLifecyclePort,
    private readonly rateLimit: RateLimitPort,
    private readonly digest: DigestPort,
    private readonly signatures: SignatureVerifierPort,
    private readonly secrets: SecretGeneratorPort,
    private readonly clock: ClockPort,
    private readonly options: {
      challengeLifetimeMs: number;
      attemptsPerWindow: number;
      rateWindowMs: number;
    } = {
      challengeLifetimeMs: 60_000,
      attemptsPerWindow: 30,
      rateWindowMs: 10 * 60_000,
    },
  ) {
    if (options.challengeLifetimeMs < 5_000 || options.challengeLifetimeMs > 2 * 60_000) {
      throw new RangeError('challenge lifetime must be between 5 seconds and 2 minutes');
    }
    if (options.attemptsPerWindow < 1 || options.rateWindowMs < 1) {
      throw new RangeError('authentication rate limit values must be positive');
    }
  }

  async issueChallenge(
    input: DeviceOwner & {
      deviceId: string;
      keyId: string;
      clientNonce: string;
    },
  ): Promise<{ serverNonce: string; expiresAt: string }> {
    validateNonce(input.clientNonce);
    const nowMs = this.clock.nowMs();
    await this.enforceRate(input, nowMs);
    const aggregate = await this.loadOwned(input);
    aggregate.assertAuthenticatable(input.keyId);
    const serverNonce = encodeBase64Url(this.secrets.bytes(24));
    const expiresAt = new Date(nowMs + this.options.challengeLifetimeMs).toISOString();
    await this.challenges.save({
      challengeId: this.secrets.uuid(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
      keyId: input.keyId,
      clientNonceHash: await nonceHash(this.digest, 'client', input.clientNonce),
      serverNonceHash: await nonceHash(this.digest, 'server', serverNonce),
      expiresAt,
    });
    return { serverNonce, expiresAt };
  }

  async authenticate(
    input: DeviceOwner & {
      deviceId: string;
      keyId: string;
      clientNonce: string;
      serverNonce: string;
      signatureBase64Url: string;
    },
  ): Promise<DeviceCredential> {
    validateNonce(input.clientNonce);
    validateNonce(input.serverNonce);
    const nowMs = this.clock.nowMs();
    await this.enforceRate(input, nowMs);
    const aggregate = await this.loadOwned(input);
    aggregate.assertAuthenticatable(input.keyId);
    const consumed = await this.challenges.consume({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
      keyId: input.keyId,
      clientNonceHash: await nonceHash(this.digest, 'client', input.clientNonce),
      serverNonceHash: await nonceHash(this.digest, 'server', input.serverNonce),
      consumedAt: new Date(nowMs).toISOString(),
    });
    if (!consumed || Date.parse(consumed.expiresAt) <= nowMs) {
      throw new DeviceChallengeRejectedError();
    }
    const verified = await this.signatures
      .verifyEd25519({
        publicKeyBase64Url: aggregate.view().publicKeyBase64Url,
        message: authenticationMessage(input),
        signatureBase64Url: input.signatureBase64Url,
      })
      .catch(() => false);
    if (!verified) throw new DeviceSignatureRejectedError();
    return this.credentials.issue(aggregate.view());
  }

  async rotateIdentity(
    input: DeviceOwner & {
      deviceId: string;
      keyId: string;
      publicKeyBase64Url: string;
    },
  ): Promise<DeviceCredential> {
    const aggregate = await this.loadOwned(input);
    const before = aggregate.view();
    aggregate.rotateIdentity(
      input.keyId,
      input.publicKeyBase64Url,
      new Date(this.clock.nowMs()).toISOString(),
    );
    const after = aggregate.view();
    await this.devices.save(after, before.credentialVersion);
    return this.credentials.rotate(after);
  }

  async revoke(
    input: DeviceOwner & {
      deviceId: string;
      reason: 'user_revoked' | 'credential_rotated' | 'device_deleted';
    },
  ): Promise<void> {
    const aggregate = await this.loadOwned(input);
    const before = aggregate.view();
    aggregate.revoke(input.reason, new Date(this.clock.nowMs()).toISOString());
    const after = aggregate.view();
    await this.devices.save(after, before.credentialVersion);
    await this.credentials.revoke(after);
  }

  private async loadOwned(input: DeviceOwner & { deviceId: string }): Promise<DeviceAggregate> {
    const snapshot = await this.devices.get(input, input.deviceId);
    if (!snapshot) throw new DeviceNotFoundError();
    const aggregate = DeviceAggregate.restore(snapshot);
    aggregate.assertOwnedBy(input);
    return aggregate;
  }

  private async enforceRate(
    input: DeviceOwner & { deviceId: string },
    nowMs: number,
  ): Promise<void> {
    const allowed = await this.rateLimit.consume({
      key: `device-auth:${input.tenantId}:${input.workspaceId}:${input.deviceId}`,
      limit: this.options.attemptsPerWindow,
      windowMs: this.options.rateWindowMs,
      nowMs,
    });
    if (!allowed) throw new DeviceRateLimitedError();
  }
}

export function authenticationMessage(input: {
  deviceId: string;
  keyId: string;
  clientNonce: string;
  serverNonce: string;
}): Uint8Array {
  return encoder.encode(
    `botmem.device.v2\n${input.deviceId}\n${input.keyId}\n${input.clientNonce}\n${input.serverNonce}`,
  );
}

async function nonceHash(
  digest: DigestPort,
  kind: 'client' | 'server',
  value: string,
): Promise<string> {
  return digest.sha256(encoder.encode(`botmem-challenge-v2\0${kind}\0${value}`));
}

function validateNonce(value: string): void {
  if (value.length < 16 || value.length > 512) {
    throw new DeviceChallengeRejectedError();
  }
}

export class DeviceNotFoundError extends Error {}
export class DeviceChallengeRejectedError extends Error {}
export class DeviceSignatureRejectedError extends Error {}
export { DeviceOwnershipError };
