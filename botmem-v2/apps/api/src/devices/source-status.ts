import { SourceStatusSchema, type SourceStatus } from '@botmem-v2/contracts';
import type { DeviceRegistryPort } from './ports.js';

export interface SourceStatusReaderPort {
  list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]>;
}

export interface DeviceSourceStatusSnapshot {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly expiresAtMs: number;
  readonly sources: readonly SourceStatus[];
}

/** Redis-compatible status metadata; it must never contain message content. */
export interface DeviceSourceStatusDirectoryPort {
  list(workspaceId: string): Promise<readonly DeviceSourceStatusSnapshot[]>;
}

export class DeviceSourceStatusReader implements SourceStatusReaderPort {
  constructor(
    private readonly devices: DeviceRegistryPort,
    private readonly statuses: DeviceSourceStatusDirectoryPort,
    private readonly nowMs: () => number,
  ) {}

  async list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]> {
    throwIfAborted(signal);
    const [devices, snapshots] = await Promise.all([
      this.devices.listForWorkspace(workspaceId),
      this.statuses.list(workspaceId),
    ]);
    throwIfAborted(signal);
    const owners = new Map(
      devices
        .filter((device) => device.workspaceId === workspaceId && device.status === 'active')
        .map((device) => [device.deviceId, device.tenantId]),
    );
    const valid = snapshots.filter(
      (snapshot) =>
        snapshot.workspaceId === workspaceId &&
        snapshot.expiresAtMs > this.nowMs() &&
        owners.get(snapshot.deviceId) === snapshot.tenantId,
    );
    return aggregateLocalStatuses(valid.flatMap((snapshot) => snapshot.sources));
  }
}

export class CombinedSourceStatusReader implements SourceStatusReaderPort {
  constructor(
    private readonly hosted: SourceStatusReaderPort,
    private readonly devices: SourceStatusReaderPort,
  ) {}

  async list(workspaceId: string, signal: AbortSignal): Promise<readonly SourceStatus[]> {
    const [hosted, devices] = await Promise.all([
      this.hosted.list(workspaceId, signal),
      this.devices.list(workspaceId, signal),
    ]);
    throwIfAborted(signal);
    return Object.freeze(
      [...hosted, ...devices].sort((left, right) => left.connector.localeCompare(right.connector)),
    );
  }
}

function aggregateLocalStatuses(statuses: readonly SourceStatus[]): readonly SourceStatus[] {
  const grouped = new Map<'imessage' | 'whatsapp', SourceStatus[]>();
  for (const value of statuses) {
    const parsed = SourceStatusSchema.parse(value);
    if (parsed.connector !== 'imessage' && parsed.connector !== 'whatsapp') continue;
    const group = grouped.get(parsed.connector) ?? [];
    group.push(parsed);
    grouped.set(parsed.connector, group);
  }
  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([connector, group]) => aggregateConnector(connector, group)),
  );
}

function aggregateConnector(
  connector: 'imessage' | 'whatsapp',
  group: readonly SourceStatus[],
): SourceStatus {
  const ready = group.filter((status) => status.readiness === 'ready' && status.searchable);
  const allReady = ready.length === group.length;
  const searchable = ready.length > 0;
  const readiness = allReady ? 'ready' : searchable ? 'degraded' : unavailableReadiness(group);
  const checkpointAt = minimumTimestamp(ready.map((status) => status.checkpointAt));
  const lastProbeAt = minimumTimestamp(ready.map((status) => status.lastProbeAt));
  const commonDetail = allReady ? 'ready' : common(group.map((status) => status.detail));
  return SourceStatusSchema.parse({
    connector,
    readiness,
    searchable,
    ...(commonDetail && commonDetail !== 'ready' ? { detail: commonDetail } : {}),
    ...(allReady ? { detail: 'ready' as const } : {}),
    indexedCount: group.reduce((total, status) => total + (status.indexedCount ?? 0), 0),
    ...(checkpointAt ? { checkpointAt } : {}),
    ...(lastProbeAt ? { lastProbeAt } : {}),
    ...(!allReady && searchable ? { reasonCode: 'some_device_sources_unavailable' } : {}),
    ...(!searchable && common(group.map((status) => status.reasonCode))
      ? { reasonCode: common(group.map((status) => status.reasonCode)) }
      : {}),
  });
}

function unavailableReadiness(group: readonly SourceStatus[]): SourceStatus['readiness'] {
  const values = new Set(group.map((status) => status.readiness));
  if (values.has('error')) return 'error';
  if (values.has('locked')) return 'locked';
  if (values.has('indexing')) return 'indexing';
  if (values.has('connected')) return 'connected';
  if (values.has('enrolling')) return 'enrolling';
  if (values.has('authorizing')) return 'authorizing';
  if (values.has('degraded')) return 'degraded';
  return 'disconnected';
}

function minimumTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function common<T>(values: readonly (T | undefined)[]): T | undefined {
  const defined = values.filter((value): value is T => value !== undefined);
  if (defined.length !== values.length || defined.length === 0) return undefined;
  return defined.every((value) => value === defined[0]) ? defined[0] : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('source status request cancelled');
}
