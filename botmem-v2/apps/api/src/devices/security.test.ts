import { describe, expect, it } from 'vitest';
import {
  DeviceAuthenticationService,
  DeviceChallengeRejectedError,
  DeviceNotFoundError,
  DeviceSignatureRejectedError,
} from './authentication-service.js';
import { encodeBase64Url, WebCryptoDeviceSecurity } from './crypto.js';
import {
  DeviceAggregate,
  DeviceKeyMismatchError,
  DeviceRevokedError,
  type DeviceSnapshot,
} from './domain.js';
import {
  DevicePairingService,
  DeviceRateLimitedError,
  PairingCodeRejectedError,
} from './pairing-service.js';
import type {
  ChallengeRecord,
  ChallengeRepositoryPort,
  ClockPort,
  CredentialLifecyclePort,
  DeviceCredential,
  DeviceRegistryPort,
  PairingCodeRepositoryPort,
  PairingGrant,
  RateLimitPort,
  SecretGeneratorPort,
  SignatureVerifierPort,
} from './ports.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_WORKSPACE_ID = '20000000-0000-4000-8000-000000000002';
const DEVICE_ID = '30000000-0000-4000-8000-000000000001';
const PUBLIC_KEY = encodeBase64Url(new Uint8Array(32).fill(7));

class FixedClock implements ClockPort {
  constructor(public value = Date.parse('2026-07-13T10:00:00.000Z')) {}
  nowMs(): number {
    return this.value;
  }
}

class FixedSecrets implements SecretGeneratorPort {
  private sequence = 1;
  bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.sequence++);
  }
  uuid(): string {
    const suffix = (this.sequence++).toString(16).padStart(12, '0');
    return `40000000-0000-4000-8000-${suffix}`;
  }
}

class MemoryPairingCodes implements PairingCodeRepositoryPort {
  readonly records = new Map<string, PairingGrant>();
  async save(grant: PairingGrant): Promise<void> {
    this.records.set(grant.codeHash, grant);
  }
  async consume(input: {
    codeHash: string;
    tenantId: string;
    workspaceId: string;
    consumedAt: string;
  }): Promise<PairingGrant | undefined> {
    const grant = this.records.get(input.codeHash);
    if (!grant || grant.tenantId !== input.tenantId || grant.workspaceId !== input.workspaceId) {
      return undefined;
    }
    this.records.delete(input.codeHash);
    return grant;
  }
}

class MemoryChallenges implements ChallengeRepositoryPort {
  readonly records: ChallengeRecord[] = [];
  async save(challenge: ChallengeRecord): Promise<void> {
    this.records.push(challenge);
  }
  async consume(input: {
    tenantId: string;
    workspaceId: string;
    deviceId: string;
    keyId: string;
    clientNonceHash: string;
    serverNonceHash: string;
    consumedAt: string;
  }): Promise<ChallengeRecord | undefined> {
    const index = this.records.findIndex(
      (record) =>
        record.tenantId === input.tenantId &&
        record.workspaceId === input.workspaceId &&
        record.deviceId === input.deviceId &&
        record.keyId === input.keyId &&
        record.clientNonceHash === input.clientNonceHash &&
        record.serverNonceHash === input.serverNonceHash,
    );
    if (index < 0) return undefined;
    return this.records.splice(index, 1)[0];
  }
}

class MemoryDevices implements DeviceRegistryPort {
  readonly records = new Map<string, DeviceSnapshot>();
  async create(device: DeviceSnapshot): Promise<void> {
    if (this.records.has(device.deviceId)) throw new Error('duplicate device');
    this.records.set(device.deviceId, device);
  }
  async get(
    owner: { tenantId: string; workspaceId: string },
    deviceId: string,
  ): Promise<DeviceSnapshot | undefined> {
    const device = this.records.get(deviceId);
    return device?.tenantId === owner.tenantId && device.workspaceId === owner.workspaceId
      ? device
      : undefined;
  }
  async listForWorkspace(workspaceId: string): Promise<readonly DeviceSnapshot[]> {
    return [...this.records.values()].filter((device) => device.workspaceId === workspaceId);
  }
  async save(device: DeviceSnapshot, expectedCredentialVersion: number): Promise<void> {
    const current = this.records.get(device.deviceId);
    if (!current || current.credentialVersion !== expectedCredentialVersion) {
      throw new Error('optimistic lock failed');
    }
    this.records.set(device.deviceId, device);
  }
}

class AllowingRateLimit implements RateLimitPort {
  allowed = true;
  async consume(): Promise<boolean> {
    return this.allowed;
  }
}

class MemoryCredentials implements CredentialLifecyclePort {
  issued: DeviceSnapshot[] = [];
  rotated: DeviceSnapshot[] = [];
  revoked: DeviceSnapshot[] = [];
  async issue(device: DeviceSnapshot): Promise<DeviceCredential> {
    this.issued.push(device);
    return credential(device);
  }
  async rotate(device: DeviceSnapshot): Promise<DeviceCredential> {
    this.rotated.push(device);
    return credential(device);
  }
  async revoke(device: DeviceSnapshot): Promise<void> {
    this.revoked.push(device);
  }
}

class ExactSignatureVerifier implements SignatureVerifierPort {
  messages: string[] = [];
  async verifyEd25519(input: {
    publicKeyBase64Url: string;
    message: Uint8Array;
    signatureBase64Url: string;
  }): Promise<boolean> {
    this.messages.push(new TextDecoder().decode(input.message));
    return (
      input.publicKeyBase64Url === PUBLIC_KEY && input.signatureBase64Url === 'valid-signature'
    );
  }
}

function credential(device: DeviceSnapshot): DeviceCredential {
  return {
    value: `credential-v${device.credentialVersion}`,
    generation: device.credentialVersion,
    issuedAt: '2026-07-13T10:00:00.000Z',
    version: device.credentialVersion,
    expiresAt: '2026-07-13T11:00:00.000Z',
  };
}

function pairedDevice(now = '2026-07-13T10:00:00.000Z'): DeviceSnapshot {
  return DeviceAggregate.pair(
    {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      displayName: 'Amr MacBook',
      keyId: 'device-key-1',
      publicKeyBase64Url: PUBLIC_KEY,
      connectors: ['imessage', 'whatsapp'],
    },
    now,
  ).view();
}

function securityFixture() {
  const clock = new FixedClock();
  const secrets = new FixedSecrets();
  const digest = new WebCryptoDeviceSecurity();
  const devices = new MemoryDevices();
  const credentials = new MemoryCredentials();
  const rateLimit = new AllowingRateLimit();
  const pairingCodes = new MemoryPairingCodes();
  const challenges = new MemoryChallenges();
  const signatures = new ExactSignatureVerifier();
  const pairing = new DevicePairingService(
    pairingCodes,
    devices,
    rateLimit,
    digest,
    secrets,
    clock,
  );
  const authentication = new DeviceAuthenticationService(
    challenges,
    devices,
    credentials,
    rateLimit,
    digest,
    signatures,
    secrets,
    clock,
  );
  return {
    clock,
    devices,
    credentials,
    rateLimit,
    pairingCodes,
    challenges,
    signatures,
    pairing,
    authentication,
  };
}

describe('device pairing and signed authentication', () => {
  it('webCryptoAdapter_verifiesARealEd25519Signature', async () => {
    const security = new WebCryptoDeviceSecurity();
    const keyPair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const message = new TextEncoder().encode('botmem signed device fixture');
    const signature = await globalThis.crypto.subtle.sign(
      { name: 'Ed25519' },
      keyPair.privateKey,
      Uint8Array.from(message).buffer,
    );
    const publicKey = await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey);
    await expect(
      security.verifyEd25519({
        publicKeyBase64Url: encodeBase64Url(new Uint8Array(publicKey)),
        message,
        signatureBase64Url: encodeBase64Url(new Uint8Array(signature)),
      }),
    ).resolves.toBe(true);
  });

  it('pairingCode_whenRedeemed_isSingleUseHashedAndWorkspaceBound', async () => {
    const fixture = securityFixture();
    const issued = await fixture.pairing.issue({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID });
    expect([...fixture.pairingCodes.records.keys()][0]).toMatch(/^[0-9a-f]{64}$/u);
    expect([...fixture.pairingCodes.records.keys()][0]).not.toContain(issued.code);

    await expect(
      fixture.pairing.complete({
        tenantId: TENANT_ID,
        workspaceId: OTHER_WORKSPACE_ID,
        code: issued.code,
        deviceId: DEVICE_ID,
        displayName: 'Amr MacBook',
        keyId: 'device-key-1',
        publicKeyBase64Url: PUBLIC_KEY,
        connectors: ['imessage'],
      }),
    ).rejects.toBeInstanceOf(PairingCodeRejectedError);

    const completed = await fixture.pairing.complete({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      code: issued.code,
      deviceId: DEVICE_ID,
      displayName: 'Amr MacBook',
      keyId: 'device-key-1',
      publicKeyBase64Url: PUBLIC_KEY,
      connectors: ['imessage'],
    });
    expect(completed.deviceId).toBe(DEVICE_ID);
    expect(fixture.credentials.issued).toHaveLength(0);
    await expect(
      fixture.pairing.complete({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        code: issued.code,
        deviceId: '30000000-0000-4000-8000-000000000002',
        displayName: 'Replay',
        keyId: 'device-key-2',
        publicKeyBase64Url: PUBLIC_KEY,
        connectors: ['imessage'],
      }),
    ).rejects.toBeInstanceOf(PairingCodeRejectedError);
  });

  it('pairingCode_whenExpired_isConsumedAndCannotBeReplayed', async () => {
    const fixture = securityFixture();
    const issued = await fixture.pairing.issue({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID });
    fixture.clock.value += 5 * 60_000;
    const attempt = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      code: issued.code,
      deviceId: DEVICE_ID,
      displayName: 'Expired Mac',
      keyId: 'device-key-1',
      publicKeyBase64Url: PUBLIC_KEY,
      connectors: ['imessage'] as const,
    };

    await expect(fixture.pairing.complete(attempt)).rejects.toBeInstanceOf(
      PairingCodeRejectedError,
    );
    expect(fixture.pairingCodes.records.size).toBe(0);
    await expect(fixture.pairing.complete(attempt)).rejects.toBeInstanceOf(
      PairingCodeRejectedError,
    );
  });

  it('challenge_whenAuthenticated_isSingleUseAndSignatureCoversBothNonces', async () => {
    const fixture = securityFixture();
    await fixture.devices.create(pairedDevice());
    const owner = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID };
    const challenge = await fixture.authentication.issueChallenge({
      ...owner,
      deviceId: DEVICE_ID,
      keyId: 'device-key-1',
      clientNonce: 'client-nonce-at-least-16',
    });
    const authentication = {
      ...owner,
      deviceId: DEVICE_ID,
      keyId: 'device-key-1',
      clientNonce: 'client-nonce-at-least-16',
      serverNonce: challenge.serverNonce,
      signatureBase64Url: 'valid-signature',
    };
    await expect(fixture.authentication.authenticate(authentication)).resolves.toMatchObject({
      version: 1,
    });
    expect(fixture.signatures.messages[0]).toContain('client-nonce-at-least-16');
    expect(fixture.signatures.messages[0]).toContain(challenge.serverNonce);
    await expect(fixture.authentication.authenticate(authentication)).rejects.toBeInstanceOf(
      DeviceChallengeRejectedError,
    );
  });

  it('authentication_whenSignatureIsWrong_consumesChallengeAndRejectsReplay', async () => {
    const fixture = securityFixture();
    await fixture.devices.create(pairedDevice());
    const challenge = await fixture.authentication.issueChallenge({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      keyId: 'device-key-1',
      clientNonce: 'client-nonce-at-least-16',
    });
    const input = {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      keyId: 'device-key-1',
      clientNonce: 'client-nonce-at-least-16',
      serverNonce: challenge.serverNonce,
      signatureBase64Url: 'wrong-signature',
    };
    await expect(fixture.authentication.authenticate(input)).rejects.toBeInstanceOf(
      DeviceSignatureRejectedError,
    );
    await expect(fixture.authentication.authenticate(input)).rejects.toBeInstanceOf(
      DeviceChallengeRejectedError,
    );
  });

  it('authentication_enforcesWorkspaceRevocationRotationAndRateLimits', async () => {
    const fixture = securityFixture();
    await fixture.devices.create(pairedDevice());
    await expect(
      fixture.authentication.issueChallenge({
        tenantId: TENANT_ID,
        workspaceId: OTHER_WORKSPACE_ID,
        deviceId: DEVICE_ID,
        keyId: 'device-key-1',
        clientNonce: 'client-nonce-at-least-16',
      }),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);

    const rotatedKey = encodeBase64Url(new Uint8Array(32).fill(8));
    const rotated = await fixture.authentication.rotateIdentity({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      keyId: 'device-key-2',
      publicKeyBase64Url: rotatedKey,
    });
    expect(rotated.version).toBe(2);
    await expect(
      fixture.authentication.issueChallenge({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        deviceId: DEVICE_ID,
        keyId: 'device-key-1',
        clientNonce: 'client-nonce-at-least-16',
      }),
    ).rejects.toBeInstanceOf(DeviceKeyMismatchError);

    await fixture.authentication.revoke({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      reason: 'user_revoked',
    });
    expect(fixture.credentials.revoked).toHaveLength(1);
    await expect(
      fixture.authentication.issueChallenge({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        deviceId: DEVICE_ID,
        keyId: 'device-key-2',
        clientNonce: 'client-nonce-at-least-16',
      }),
    ).rejects.toBeInstanceOf(DeviceRevokedError);

    fixture.rateLimit.allowed = false;
    await expect(
      fixture.pairing.issue({ tenantId: TENANT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(DeviceRateLimitedError);
  });
});
