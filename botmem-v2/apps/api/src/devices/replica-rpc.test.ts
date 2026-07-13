import { describe, expect, it } from 'vitest';
import type { DevicePresence, OutboundDeviceSessionPort, ReplicaRequestBusPort } from './ports.js';
import { OutboundSessionReplicaRpc, OutboundSessionStaleError } from './replica-rpc.js';

const presence: DevicePresence = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001',
  deviceId: '30000000-0000-4000-8000-000000000001',
  sessionId: 'session-1',
  ownerReplicaId: 'replica-1',
  connectors: ['imessage'],
  availability: 'ready',
  expiresAtMs: Date.now() + 60_000,
};

describe('outbound session replica RPC', () => {
  it('request_routesLocalSocketOrRemoteReplicaWithoutPersistenceSurface', async () => {
    const localFrames: Uint8Array[] = [];
    const remoteFrames: Uint8Array[] = [];
    const session: OutboundDeviceSessionPort = {
      sessionId: presence.sessionId,
      deviceId: presence.deviceId,
      request: async (frame) => {
        localFrames.push(frame);
        return Uint8Array.of(2);
      },
      send: async (frame) => {
        localFrames.push(frame);
      },
    };
    const bus: ReplicaRequestBusPort = {
      request: async (_replica, _session, frame) => {
        remoteFrames.push(frame);
        return Uint8Array.of(3);
      },
      send: async (_replica, _session, frame) => {
        remoteFrames.push(frame);
      },
    };
    const rpc = new OutboundSessionReplicaRpc(
      'replica-1',
      { get: (sessionId) => (sessionId === presence.sessionId ? session : undefined) },
      bus,
    );
    await expect(
      rpc.request(presence, Uint8Array.of(1), new AbortController().signal),
    ).resolves.toEqual(Uint8Array.of(2));
    await expect(
      rpc.request(
        { ...presence, ownerReplicaId: 'replica-2' },
        Uint8Array.of(1),
        new AbortController().signal,
      ),
    ).resolves.toEqual(Uint8Array.of(3));
    expect(localFrames).toHaveLength(1);
    expect(remoteFrames).toHaveLength(1);
  });

  it('request_rejectsAStaleLocalPresenceSession', async () => {
    const rpc = new OutboundSessionReplicaRpc(
      'replica-1',
      { get: () => undefined },
      {
        request: async () => Uint8Array.of(),
        send: async () => undefined,
      },
    );
    await expect(
      rpc.request(presence, Uint8Array.of(1), new AbortController().signal),
    ).rejects.toBeInstanceOf(OutboundSessionStaleError);
  });
});
