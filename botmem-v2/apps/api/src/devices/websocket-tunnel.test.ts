import type { DeviceFrame } from '@botmem-v2/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { DeviceSnapshot } from './domain.js';
import type { DevicePresence, PresenceDirectoryPort } from './ports.js';
import type { RedisDeviceSourceStatusDirectory } from './redis-adapters.js';
import { LiveOutboundDeviceSession, TunnelClosedError } from './websocket-tunnel.js';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const DEVICE_ID = '30000000-0000-4000-8000-000000000001';
const SESSION_ID = '40000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveOutboundDeviceSession credential expiry', () => {
  it('credentialExpiry_closesSocketAndRemovesEphemeralStateExactlyOnce', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const state = fixture();
    await state.session.refreshPresence('ready');

    await vi.advanceTimersByTimeAsync(999);
    expect(state.socket.close).not.toHaveBeenCalled();
    expect(state.presence.records.has(DEVICE_ID)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.socket.close).toHaveBeenCalledTimes(1);
    expect(state.socket.close).toHaveBeenCalledWith(1008, 'credential_expired');
    expect(state.presence.records.has(DEVICE_ID)).toBe(false);
    expect(state.sourceStatuses.removeIfCurrent).toHaveBeenCalledTimes(1);

    await state.session.closed();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.socket.close).toHaveBeenCalledTimes(1);
    expect(state.presence.removeCalls).toBe(1);
    expect(state.sourceStatuses.removeIfCurrent).toHaveBeenCalledTimes(1);
  });

  it('externalClose_cancelsStaleExpiryAndKeepsCleanupIdempotent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const state = fixture();
    await state.session.refreshPresence('ready');

    await Promise.all([state.session.closed(), state.session.closed()]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(state.socket.close).not.toHaveBeenCalled();
    expect(state.presence.records.has(DEVICE_ID)).toBe(false);
    expect(state.presence.removeCalls).toBe(1);
    expect(state.sourceStatuses.removeIfCurrent).toHaveBeenCalledTimes(1);
  });

  it('expiryRacingInflightHeartbeat_cannotResurrectPresence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = deferred<void>();
    const state = fixture(gate.promise);
    const heartbeat = state.session.accept(heartbeatFrame()).then(
      () => undefined,
      (error: unknown) => error,
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    gate.resolve();
    expect(await heartbeat).toBeInstanceOf(TunnelClosedError);

    expect(state.socket.close).toHaveBeenCalledWith(1008, 'credential_expired');
    expect(state.presence.records.has(DEVICE_ID)).toBe(false);
    // The first removal handles expiry; the second removes the write that was
    // already in flight when expiry won the race.
    expect(state.presence.removeCalls).toBe(2);
  });
});

function fixture(blockedUpsert: Promise<void> = Promise.resolve()) {
  const socket = new FakeSocket();
  const presence = new MemoryPresence(blockedUpsert);
  const sourceStatuses = {
    removeIfCurrent: vi.fn(async () => undefined),
  } as unknown as RedisDeviceSourceStatusDirectory;
  const session = new LiveOutboundDeviceSession({
    socket: socket as unknown as WebSocket,
    sessionId: SESSION_ID,
    sessionGeneration: 1,
    device: device(),
    clientVersion: '2.0.0',
    replicaId: 'api-test-1',
    heartbeatIntervalMs: 20_000,
    presence,
    sourceStatuses,
    nowMs: () => Date.now(),
    credentialExpiresAtMs: NOW + 1_000,
  });
  return { socket, presence, sourceStatuses, session };
}

class FakeSocket {
  readyState = 1;
  readonly close = vi.fn((_code: number, _reason: string) => {
    this.readyState = 3;
  });
}

class MemoryPresence implements PresenceDirectoryPort {
  readonly records = new Map<string, DevicePresence>();
  removeCalls = 0;

  constructor(private readonly blockedUpsert: Promise<void>) {}

  async upsert(presence: DevicePresence): Promise<void> {
    await this.blockedUpsert;
    this.records.set(presence.deviceId, presence);
  }

  async removeIfCurrent(_workspaceId: string, deviceId: string, sessionId: string): Promise<void> {
    this.removeCalls += 1;
    if (this.records.get(deviceId)?.sessionId === sessionId) this.records.delete(deviceId);
  }

  async get(workspaceId: string, deviceId: string): Promise<DevicePresence | undefined> {
    const value = this.records.get(deviceId);
    return value?.workspaceId === workspaceId ? value : undefined;
  }

  async list(workspaceId: string): Promise<readonly DevicePresence[]> {
    return [...this.records.values()].filter((value) => value.workspaceId === workspaceId);
  }
}

function device(): DeviceSnapshot {
  return {
    tenantId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    deviceId: DEVICE_ID,
    displayName: 'Security test Mac',
    keyId: 'security-test-key',
    publicKeyBase64Url: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    connectors: ['imessage'],
    status: 'active',
    credentialVersion: 1,
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z',
  };
}

function heartbeatFrame(): DeviceFrame {
  return {
    protocol: 'botmem.device.v2',
    requestId: '50000000-0000-4000-8000-000000000001',
    sentAt: '2026-07-13T12:00:00.000Z',
    deadlineAt: '2026-07-13T12:00:05.000Z',
    type: 'heartbeat',
    payload: { sessionId: SESSION_ID, sequence: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
