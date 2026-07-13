import {
  assertDeviceOwner,
  DeviceAggregate,
  type DeviceOwner,
  type LocalConnector,
} from './domain.js';
import { encodeBase64Url } from './crypto.js';
import type {
  ClockPort,
  DeviceRegistryPort,
  DigestPort,
  PairingCodeRepositoryPort,
  RateLimitPort,
  SecretGeneratorPort,
} from './ports.js';

const encoder = new TextEncoder();

export interface PairingServiceOptions {
  readonly lifetimeMs: number;
  readonly issueRateLimit: number;
  readonly redeemRateLimit: number;
  readonly rateWindowMs: number;
}

export class DevicePairingService {
  constructor(
    private readonly pairingCodes: PairingCodeRepositoryPort,
    private readonly devices: DeviceRegistryPort,
    private readonly rateLimit: RateLimitPort,
    private readonly digest: DigestPort,
    private readonly secrets: SecretGeneratorPort,
    private readonly clock: ClockPort,
    private readonly options: PairingServiceOptions = {
      lifetimeMs: 5 * 60_000,
      issueRateLimit: 5,
      redeemRateLimit: 20,
      rateWindowMs: 10 * 60_000,
    },
  ) {
    if (options.lifetimeMs < 30_000 || options.lifetimeMs > 15 * 60_000) {
      throw new RangeError('pairing code lifetime must be between 30 seconds and 15 minutes');
    }
  }

  async issue(owner: DeviceOwner): Promise<{ code: string; expiresAt: string }> {
    assertDeviceOwner(owner);
    const nowMs = this.clock.nowMs();
    await this.enforceRate(`pairing:issue:${owner.tenantId}:${owner.workspaceId}`, {
      limit: this.options.issueRateLimit,
      nowMs,
    });
    const code = `BM2-${encodeBase64Url(this.secrets.bytes(18))}`;
    const expiresAt = new Date(nowMs + this.options.lifetimeMs).toISOString();
    await this.pairingCodes.save({
      grantId: this.secrets.uuid(),
      ...owner,
      codeHash: await pairingHash(this.digest, code),
      expiresAt,
    });
    return { code, expiresAt };
  }

  async complete(
    input: DeviceOwner & {
      code: string;
      deviceId: string;
      displayName: string;
      keyId: string;
      publicKeyBase64Url: string;
      connectors: readonly LocalConnector[];
    },
  ): Promise<{ deviceId: string }> {
    const nowMs = this.clock.nowMs();
    await this.enforceRate(`pairing:redeem:${input.tenantId}:${input.workspaceId}`, {
      limit: this.options.redeemRateLimit,
      nowMs,
    });
    const consumedAt = new Date(nowMs).toISOString();
    const grant = await this.pairingCodes.consume({
      codeHash: await pairingHash(this.digest, input.code),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      consumedAt,
    });
    if (
      !grant ||
      grant.tenantId !== input.tenantId ||
      grant.workspaceId !== input.workspaceId ||
      Date.parse(grant.expiresAt) <= nowMs
    ) {
      throw new PairingCodeRejectedError();
    }

    const aggregate = DeviceAggregate.pair(
      {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        displayName: input.displayName,
        keyId: input.keyId,
        publicKeyBase64Url: input.publicKeyBase64Url,
        connectors: input.connectors,
      },
      consumedAt,
    );
    const device = aggregate.view();
    await this.devices.create(device);
    return { deviceId: device.deviceId };
  }

  private async enforceRate(key: string, input: { limit: number; nowMs: number }): Promise<void> {
    const allowed = await this.rateLimit.consume({
      key,
      limit: input.limit,
      windowMs: this.options.rateWindowMs,
      nowMs: input.nowMs,
    });
    if (!allowed) throw new DeviceRateLimitedError();
  }
}

async function pairingHash(digest: DigestPort, code: string): Promise<string> {
  return digest.sha256(encoder.encode(`botmem-pairing-v2\0${code}`));
}

export class PairingCodeRejectedError extends Error {}
export class DeviceRateLimitedError extends Error {}
