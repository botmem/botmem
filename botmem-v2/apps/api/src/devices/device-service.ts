import { DeviceListResponseSchema, type DeviceListResponse } from '@botmem-v2/contracts';
import type { DevicesApplicationService } from '@botmem-v2/sdk';
import type { DeviceRegistryPort, PresenceDirectoryPort } from './ports.js';
import type { DeviceSourceStatusDirectoryPort } from './source-status.js';

/** Canonical list service shared by HTTP and MCP through the SDK port. */
export class DeviceListService implements DevicesApplicationService {
  constructor(
    private readonly devices: DeviceRegistryPort,
    private readonly presence: PresenceDirectoryPort,
    private readonly statuses: DeviceSourceStatusDirectoryPort,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async listDevices(workspaceId: string): Promise<DeviceListResponse> {
    const [devices, presence, statuses] = await Promise.all([
      this.devices.listForWorkspace(workspaceId),
      this.presence.list(workspaceId),
      this.statuses.list(workspaceId),
    ]);
    const nowMs = this.nowMs();
    const liveByDevice = new Map(
      presence
        .filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            entry.tenantId === workspaceId &&
            entry.expiresAtMs > nowMs,
        )
        .map((entry) => [entry.deviceId, entry]),
    );
    const statusByDevice = new Map(
      statuses
        .filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            entry.tenantId === workspaceId &&
            entry.expiresAtMs > nowMs,
        )
        .map((entry) => [entry.deviceId, entry.sources]),
    );
    return DeviceListResponseSchema.parse({
      version: 2,
      items: devices.map((device) => {
        const live = liveByDevice.get(device.deviceId);
        const online = Boolean(live?.lastSeenAtMs);
        return {
          deviceId: device.deviceId,
          displayName: device.displayName,
          state: device.status === 'revoked' ? 'revoked' : online ? 'online' : 'offline',
          connectors: [...device.connectors],
          ...(online && live?.lastSeenAtMs
            ? { lastSeenAt: new Date(live.lastSeenAtMs).toISOString() }
            : {}),
          ...(live?.clientVersion ? { clientVersion: live.clientVersion } : {}),
          sources: (statusByDevice.get(device.deviceId) ?? []).filter((source) =>
            device.connectors.some((connector) => connector === source.connector),
          ),
        };
      }),
    });
  }
}
