import {
  DEVICE_PROTOCOL,
  DeviceFrameSchema,
  MAX_DEVICE_FRAME_BYTES,
  SearchCandidateSchema,
  type Connector,
  type DeviceFrame,
  type SearchCandidate,
  type SearchRequest,
} from '@botmem-v2/contracts';
import type {
  DeviceDirectoryPort,
  DeviceSearchPort,
  DeviceTarget,
  RankedLaneResult,
  SearchLaneContext,
} from '@botmem-v2/search-domain';
import type { DeviceSnapshot, LocalConnector } from './domain.js';
import type {
  ClockPort,
  DevicePresence,
  DeviceRegistryPort,
  PresenceDirectoryPort,
  ReplicaDeviceRpcPort,
  SecretGeneratorPort,
} from './ports.js';

const encoder = new TextEncoder();

export class ReplicaNeutralDeviceRouter implements DeviceDirectoryPort, DeviceSearchPort {
  constructor(
    private readonly devices: DeviceRegistryPort,
    private readonly presence: PresenceDirectoryPort,
    private readonly rpc: ReplicaDeviceRpcPort,
    private readonly clock: ClockPort,
    private readonly ids: SecretGeneratorPort,
    private readonly requestTimeoutMs = 5_000,
  ) {
    if (requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new RangeError('device request timeout must be between 1 and 30000ms');
    }
  }

  async listSearchTargets(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<readonly DeviceTarget[]> {
    throwIfAborted(signal);
    const [registered, connected] = await Promise.all([
      this.devices.listForWorkspace(workspaceId),
      this.presence.list(workspaceId),
    ]);
    throwIfAborted(signal);
    const active = registered.filter(
      (device) => device.workspaceId === workspaceId && device.status === 'active',
    );
    if (active.length === 0) throw new NoEligibleDeviceError();
    const byDevice = new Map(connected.map((entry) => [entry.deviceId, entry]));
    return active
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
      .map((device) => this.toTarget(device, byDevice.get(device.deviceId)));
  }

  async search(
    workspaceId: string,
    target: DeviceTarget,
    request: SearchRequest,
    context: SearchLaneContext,
  ): Promise<RankedLaneResult> {
    throwIfAborted(context.signal);
    if (target.availability !== 'ready') throw new DeviceRouteOfflineError();
    const owner = { tenantId: workspaceId, workspaceId };
    const device = await this.devices.get(owner, target.deviceId);
    throwIfAborted(context.signal);
    if (!device || device.workspaceId !== workspaceId) throw new DeviceRouteOwnershipError();
    if (device.status !== 'active') throw new DeviceRouteRevokedError();
    const presence = await this.presence.get(workspaceId, target.deviceId);
    throwIfAborted(context.signal);
    if (!presence || presence.expiresAtMs <= this.clock.nowMs()) {
      throw new DeviceRouteOfflineError();
    }
    if (
      presence.workspaceId !== workspaceId ||
      presence.tenantId !== device.tenantId ||
      presence.deviceId !== device.deviceId
    ) {
      throw new DeviceRouteOwnershipError();
    }

    const connectors = selectedConnectors(request.connectors, presence.connectors);
    if (connectors.length === 0) throw new NoEligibleDeviceError();
    const startedAtMs = this.clock.nowMs();
    const deadlineAtMs = startedAtMs + this.requestTimeoutMs;
    const frame = DeviceFrameSchema.parse({
      protocol: DEVICE_PROTOCOL,
      requestId: this.ids.uuid(),
      sentAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      type: 'search.request',
      payload: {
        queryId: context.queryId,
        query: {
          query: request.query,
          connectors,
          ...(request.kinds ? { kinds: ['message'] as const } : {}),
          ...(request.from ? { from: request.from } : {}),
          ...(request.to ? { to: request.to } : {}),
          ...(request.participantId ? { participantId: request.participantId } : {}),
          ...(request.authoredByMe !== undefined ? { authoredByMe: request.authoredByMe } : {}),
          limit: Math.min(request.limit, 100),
          cursor: null,
        },
      },
    });
    const encoded = encodeFrame(frame);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DeviceRouteTimeoutError());
    }, this.requestTimeoutMs);

    try {
      const responseBytes = await Promise.race([
        this.rpc.request(presence, encoded, controller.signal),
        aborted(controller.signal),
      ]);
      const response = parseResponse(responseBytes, context.queryId, deadlineAtMs);
      if (response.payload.items.some((item) => !connectors.includes(item.connector))) {
        throw new DeviceRouteProtocolError();
      }
      return {
        candidates: response.payload.items.map((item) => toCandidate(device.deviceId, item)),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const cancel = cancellationFrame(
          this.ids.uuid(),
          context.queryId,
          this.clock.nowMs(),
          timedOut ? 'deadline_exceeded' : 'caller_cancelled',
        );
        void this.rpc.cancel(presence, encodeFrame(cancel)).catch(() => undefined);
        if (timedOut) throw new DeviceRouteTimeoutError();
        throw new DeviceRouteCancelledError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', abortFromCaller);
    }
  }

  private toTarget(device: DeviceSnapshot, presence: DevicePresence | undefined): DeviceTarget {
    if (!presence || presence.expiresAtMs <= this.clock.nowMs()) {
      return {
        deviceId: device.deviceId,
        availability: 'offline',
        connectors: device.connectors,
        reasonCode: 'device_disconnected',
      };
    }
    if (presence.tenantId !== device.tenantId || presence.workspaceId !== device.workspaceId) {
      return {
        deviceId: device.deviceId,
        availability: 'failed',
        connectors: device.connectors,
        reasonCode: 'device_presence_owner_mismatch',
      };
    }
    return {
      deviceId: device.deviceId,
      availability: presence.availability,
      connectors: presence.connectors,
      ...(presence.reasonCode ? { reasonCode: presence.reasonCode } : {}),
    };
  }
}

function selectedConnectors(
  requested: readonly Connector[] | undefined,
  available: readonly LocalConnector[],
): LocalConnector[] {
  const requestedLocal = requested?.filter(
    (connector): connector is LocalConnector =>
      connector === 'imessage' || connector === 'whatsapp',
  );
  return [
    ...new Set(
      available.filter((connector) => !requestedLocal || requestedLocal.includes(connector)),
    ),
  ].sort();
}

function encodeFrame(frame: DeviceFrame): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(frame));
  if (bytes.byteLength > MAX_DEVICE_FRAME_BYTES) throw new DeviceRouteFrameTooLargeError();
  return bytes;
}

function parseResponse(
  bytes: Uint8Array,
  queryId: string,
  deadlineAtMs: number,
): Extract<DeviceFrame, { type: 'search.response' }> {
  if (bytes.byteLength > MAX_DEVICE_FRAME_BYTES) throw new DeviceRouteFrameTooLargeError();
  const frame = DeviceFrameSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  if (frame.type !== 'search.response' || frame.payload.queryId !== queryId) {
    throw new DeviceRouteProtocolError();
  }
  if (Date.parse(frame.sentAt) > deadlineAtMs) throw new DeviceRouteTimeoutError();
  return frame;
}

function toCandidate(
  deviceId: string,
  item: Extract<DeviceFrame, { type: 'search.response' }>['payload']['items'][number],
): SearchCandidate {
  return SearchCandidateSchema.parse({
    ref: item.ref,
    sourceId: item.sourceId,
    revision: item.revision,
    origin: { placement: 'device', connector: item.connector, deviceId },
    kind: 'message',
    occurredAt: item.occurredAt,
    ...(item.title ? { title: item.title } : {}),
    text: item.text,
    ...(item.thread ? { thread: item.thread } : {}),
    participants: item.participants,
    media: item.media,
    ...(item.authoredByMe !== undefined ? { authoredByMe: item.authoredByMe } : {}),
    citation: `botmem://device/${deviceId}/${item.connector}/${encodeURIComponent(item.sourceId)}`,
  });
}

function cancellationFrame(
  requestId: string,
  queryId: string,
  nowMs: number,
  reasonCode: 'caller_cancelled' | 'deadline_exceeded',
): DeviceFrame {
  return DeviceFrameSchema.parse({
    protocol: DEVICE_PROTOCOL,
    requestId,
    sentAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + 1_000).toISOString(),
    type: 'search.cancel',
    payload: { queryId, reasonCode },
  });
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeviceRouteCancelledError();
}

export class NoEligibleDeviceError extends Error {}
export class DeviceRouteOwnershipError extends Error {}
export class DeviceRouteRevokedError extends Error {}
export class DeviceRouteOfflineError extends Error {}
export class DeviceRouteTimeoutError extends Error {}
export class DeviceRouteCancelledError extends Error {}
export class DeviceRouteFrameTooLargeError extends Error {}
export class DeviceRouteProtocolError extends Error {}
