import { DEVICE_PROTOCOL, DeviceFrameSchema } from '@botmem-v2/contracts';
import type {
  ClockPort,
  PresenceDirectoryPort,
  ReplicaDeviceRpcPort,
  SecretGeneratorPort,
} from './ports.js';

export interface DeviceSessionRevocationPort {
  revoke(
    workspaceId: string,
    deviceId: string,
    reason: 'user_revoked' | 'credential_rotated' | 'device_deleted',
  ): Promise<void>;
}

/** Revokes the outbound session on its owning replica, then removes its route. */
export class RoutedDeviceSessionRevoker implements DeviceSessionRevocationPort {
  constructor(
    private readonly presence: PresenceDirectoryPort,
    private readonly rpc: ReplicaDeviceRpcPort,
    private readonly ids: SecretGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async revoke(
    workspaceId: string,
    deviceId: string,
    reason: 'user_revoked' | 'credential_rotated' | 'device_deleted',
  ): Promise<void> {
    const current = await this.presence.get(workspaceId, deviceId);
    if (!current) return;
    const nowMs = this.clock.nowMs();
    const frame = new TextEncoder().encode(
      JSON.stringify(
        DeviceFrameSchema.parse({
          protocol: DEVICE_PROTOCOL,
          requestId: this.ids.uuid(),
          sentAt: new Date(nowMs).toISOString(),
          deadlineAt: new Date(nowMs + 5_000).toISOString(),
          type: 'revoke',
          payload: { reasonCode: reason },
        }),
      ),
    );
    try {
      await this.rpc.cancel(current, frame);
    } finally {
      await this.presence.removeIfCurrent(workspaceId, deviceId, current.sessionId);
    }
  }
}
