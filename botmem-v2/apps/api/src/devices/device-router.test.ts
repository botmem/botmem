import {
  DEVICE_PROTOCOL,
  DeviceFrameSchema,
  MAX_DEVICE_FRAME_BYTES,
  type DeviceFrame,
  type SearchRequest,
} from '@botmem-v2/contracts';
import { FederatedSearchService } from '@botmem-v2/search-domain';
import { describe, expect, it } from 'vitest';
import {
  DeviceRouteCancelledError,
  DeviceRouteFrameTooLargeError,
  DeviceRouteOwnershipError,
  DeviceRouteRevokedError,
  DeviceRouteTimeoutError,
  ReplicaNeutralDeviceRouter,
} from './device-router.js';
import { DeviceAggregate, type DeviceSnapshot } from './domain.js';
import { encodeBase64Url } from './crypto.js';
import type {
  ClockPort,
  DevicePresence,
  DeviceRegistryPort,
  PresenceDirectoryPort,
  ReplicaDeviceRpcPort,
  SecretGeneratorPort,
} from './ports.js';

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
// V4 launch identity intentionally uses one workspace per tenant.
const TENANT_ID = WORKSPACE_ID;
const OTHER_WORKSPACE_ID = '20000000-0000-4000-8000-000000000002';
const DEVICE_1 = '30000000-0000-4000-8000-000000000001';
const DEVICE_2 = '30000000-0000-4000-8000-000000000002';
const QUERY_ID = '50000000-0000-4000-8000-000000000001';
const PUBLIC_KEY = encodeBase64Url(new Uint8Array(32).fill(7));
const encoder = new TextEncoder();

class FixedClock implements ClockPort {
  value = Date.parse('2026-07-13T10:00:00.000Z');
  nowMs(): number {
    return this.value;
  }
}

class SequenceIds implements SecretGeneratorPort {
  sequence = 1;
  bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.sequence++);
  }
  uuid(): string {
    const suffix = (this.sequence++).toString(16).padStart(12, '0');
    return `60000000-0000-4000-8000-${suffix}`;
  }
}

class MemoryDevices implements DeviceRegistryPort {
  readonly records = new Map<string, DeviceSnapshot>();
  async create(device: DeviceSnapshot): Promise<void> {
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
  async save(device: DeviceSnapshot): Promise<void> {
    this.records.set(device.deviceId, device);
  }
}

class MemoryPresence implements PresenceDirectoryPort {
  readonly records = new Map<string, DevicePresence>();
  async upsert(presence: DevicePresence): Promise<void> {
    this.records.set(presence.deviceId, presence);
  }
  async removeIfCurrent(_workspaceId: string, deviceId: string, sessionId: string): Promise<void> {
    if (this.records.get(deviceId)?.sessionId === sessionId) this.records.delete(deviceId);
  }
  async get(workspaceId: string, deviceId: string): Promise<DevicePresence | undefined> {
    const found = this.records.get(deviceId);
    return found?.workspaceId === workspaceId ? found : undefined;
  }
  async list(workspaceId: string): Promise<readonly DevicePresence[]> {
    return [...this.records.values()].filter((entry) => entry.workspaceId === workspaceId);
  }
}

class SessionRpc implements ReplicaDeviceRpcPort {
  readonly requests: Array<{ presence: DevicePresence; frame: DeviceFrame }> = [];
  readonly cancellations: DeviceFrame[] = [];
  mode: 'respond' | 'wait' | 'oversized' = 'respond';

  async request(
    presence: DevicePresence,
    frameBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const frame = parseFrame(frameBytes);
    this.requests.push({ presence, frame });
    if (this.mode === 'oversized') return new Uint8Array(MAX_DEVICE_FRAME_BYTES + 1);
    if (this.mode === 'wait') {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (frame.type !== 'search.request') throw new Error('expected search request');
    return encoder.encode(
      JSON.stringify(
        DeviceFrameSchema.parse({
          protocol: DEVICE_PROTOCOL,
          requestId: '70000000-0000-4000-8000-000000000001',
          sentAt: '2026-07-13T10:00:00.001Z',
          deadlineAt: '2026-07-13T10:00:01.000Z',
          type: 'search.response',
          payload: {
            queryId: frame.payload.queryId,
            items: [
              {
                ref: `imessage:${presence.sessionId}`,
                sourceId: presence.sessionId,
                revision: 'revision-1',
                connector: 'imessage',
                occurredAt: '2026-07-13T09:00:00.000Z',
                text: `result through ${presence.sessionId}`,
                participants: [],
                media: [],
              },
            ],
            found: 1,
            nextCursor: null,
            tookMs: 2,
          },
        }),
      ),
    );
  }

  async cancel(_presence: DevicePresence, frameBytes: Uint8Array): Promise<void> {
    this.cancellations.push(parseFrame(frameBytes));
  }
}

function parseFrame(bytes: Uint8Array): DeviceFrame {
  return DeviceFrameSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

function device(deviceId: string, workspaceId = WORKSPACE_ID): DeviceSnapshot {
  return DeviceAggregate.pair(
    {
      tenantId: TENANT_ID,
      workspaceId,
      deviceId,
      displayName: `Mac ${deviceId.at(-1)}`,
      keyId: `key-${deviceId}`,
      publicKeyBase64Url: PUBLIC_KEY,
      connectors: ['imessage', 'whatsapp'],
    },
    '2026-07-13T09:00:00.000Z',
  ).view();
}

function online(deviceId: string, sessionId: string): DevicePresence {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    deviceId,
    sessionId,
    ownerReplicaId: 'api-replica-2',
    connectors: ['imessage', 'whatsapp'],
    availability: 'ready',
    expiresAtMs: Date.parse('2026-07-13T10:05:00.000Z'),
  };
}

function target(deviceId = DEVICE_1) {
  return {
    deviceId,
    availability: 'ready' as const,
    connectors: ['imessage', 'whatsapp'] as const,
  };
}

function request(): SearchRequest {
  return {
    version: 2 as const,
    query: 'launch',
    connectors: ['imessage'],
    kinds: ['message'],
    limit: 20,
  };
}

function context(signal = new AbortController().signal) {
  return { queryId: QUERY_ID, signal };
}

function fixture(timeoutMs = 50) {
  const devices = new MemoryDevices();
  const presence = new MemoryPresence();
  const rpc = new SessionRpc();
  const clock = new FixedClock();
  const router = new ReplicaNeutralDeviceRouter(
    devices,
    presence,
    rpc,
    clock,
    new SequenceIds(),
    timeoutMs,
  );
  return { devices, presence, rpc, clock, router };
}

describe('replica-neutral device directory and router', () => {
  it('directory_whenMultipleDevicesReconnects_routesOnlyTheLatestOutboundSession', async () => {
    const state = fixture();
    await state.devices.create(device(DEVICE_1));
    await state.devices.create(device(DEVICE_2));
    await state.presence.upsert(online(DEVICE_1, 'session-old'));
    await state.presence.upsert(online(DEVICE_1, 'session-new'));

    const targets = await state.router.listSearchTargets(
      WORKSPACE_ID,
      new AbortController().signal,
    );
    expect(targets).toEqual([
      target(DEVICE_1),
      {
        deviceId: DEVICE_2,
        availability: 'offline',
        connectors: ['imessage', 'whatsapp'],
        reasonCode: 'device_disconnected',
      },
    ]);

    const result = await state.router.search(WORKSPACE_ID, target(), request(), context());
    expect(result.candidates[0]).toMatchObject({
      sourceId: 'session-new',
      origin: { placement: 'device', deviceId: DEVICE_1, connector: 'imessage' },
      citation: `botmem://device/${DEVICE_1}/imessage/session-new`,
    });
    expect(state.rpc.requests[0]?.presence.sessionId).toBe('session-new');
    const outbound = state.rpc.requests[0]?.frame;
    expect(outbound?.type).toBe('search.request');
    if (outbound?.type === 'search.request') {
      expect(outbound.payload.query.cursor).toBeNull();
      expect(outbound.payload.query.connectors).toEqual(['imessage']);
    }
  });

  it('router_rejectsWrongWorkspaceRevokedAndOversizedResponse', async () => {
    const state = fixture();
    await state.devices.create(device(DEVICE_1));
    await state.presence.upsert(online(DEVICE_1, 'session-1'));
    await expect(
      state.router.search(OTHER_WORKSPACE_ID, target(), request(), context()),
    ).rejects.toBeInstanceOf(DeviceRouteOwnershipError);

    const revoked = DeviceAggregate.restore(device(DEVICE_1));
    revoked.revoke('user_revoked', '2026-07-13T09:30:00.000Z');
    state.devices.records.set(DEVICE_1, revoked.view());
    await expect(
      state.router.search(WORKSPACE_ID, target(), request(), context()),
    ).rejects.toBeInstanceOf(DeviceRouteRevokedError);

    state.devices.records.set(DEVICE_1, device(DEVICE_1));
    state.rpc.mode = 'oversized';
    await expect(
      state.router.search(WORKSPACE_ID, target(), request(), context()),
    ).rejects.toBeInstanceOf(DeviceRouteFrameTooLargeError);
  });

  it('router_timeoutAndCallerCancellation_forwardBoundedCancelFrames', async () => {
    const timed = fixture(5);
    await timed.devices.create(device(DEVICE_1));
    await timed.presence.upsert(online(DEVICE_1, 'session-timeout'));
    timed.rpc.mode = 'wait';
    await expect(
      timed.router.search(WORKSPACE_ID, target(), request(), context()),
    ).rejects.toBeInstanceOf(DeviceRouteTimeoutError);
    expect(timed.rpc.cancellations[0]).toMatchObject({
      type: 'search.cancel',
      payload: { queryId: QUERY_ID, reasonCode: 'deadline_exceeded' },
    });

    const cancelled = fixture(100);
    await cancelled.devices.create(device(DEVICE_1));
    await cancelled.presence.upsert(online(DEVICE_1, 'session-cancel'));
    cancelled.rpc.mode = 'wait';
    const controller = new AbortController();
    const pending = cancelled.router.search(
      WORKSPACE_ID,
      target(),
      request(),
      context(controller.signal),
    );
    while (cancelled.rpc.requests.length === 0) await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DeviceRouteCancelledError);
    expect(cancelled.rpc.cancellations[0]).toMatchObject({
      type: 'search.cancel',
      payload: { queryId: QUERY_ID, reasonCode: 'caller_cancelled' },
    });
  });

  it('federation_noEligibleOrOfflineDevice_returnsExplicitPartialCoverage', async () => {
    const empty = fixture();
    const serviceWithoutDevices = new FederatedSearchService(
      { search: async () => ({ candidates: [] }) },
      empty.router,
      empty.router,
      empty.clock,
      { next: () => QUERY_ID },
      { hostedDeadlineMs: 20, deviceDeadlineMs: 20, reciprocalRankConstant: 60 },
    );
    const absent = await serviceWithoutDevices.search(WORKSPACE_ID, request());
    expect(absent.coverage).toEqual({
      partial: true,
      lanes: [
        {
          laneId: 'device-directory',
          placement: 'device',
          status: 'failed',
          retryable: true,
          returned: 0,
          tookMs: 0,
          reasonCode: 'device_directory_unavailable',
        },
      ],
    });

    const offline = fixture();
    await offline.devices.create(device(DEVICE_1));
    const serviceOffline = new FederatedSearchService(
      { search: async () => ({ candidates: [] }) },
      offline.router,
      offline.router,
      offline.clock,
      { next: () => QUERY_ID },
      { hostedDeadlineMs: 20, deviceDeadlineMs: 20, reciprocalRankConstant: 60 },
    );
    const response = await serviceOffline.search(WORKSPACE_ID, request());
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toContainEqual({
      laneId: `device:${DEVICE_1}`,
      placement: 'device',
      deviceId: DEVICE_1,
      status: 'offline',
      retryable: true,
      returned: 0,
      tookMs: 0,
      reasonCode: 'device_disconnected',
    });
  });
});
