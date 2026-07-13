import type {
  DevicePresence,
  LocalOutboundSessionRegistryPort,
  ReplicaDeviceRpcPort,
  ReplicaRequestBusPort,
} from './ports.js';

/**
 * Selects the live outbound socket on this replica or an ephemeral request bus
 * to its owning replica. Neither branch exposes a persistence or logging hook.
 */
export class OutboundSessionReplicaRpc implements ReplicaDeviceRpcPort {
  constructor(
    private readonly replicaId: string,
    private readonly localSessions: LocalOutboundSessionRegistryPort,
    private readonly bus: ReplicaRequestBusPort,
  ) {
    if (!replicaId || replicaId.length > 128) throw new RangeError('replicaId is invalid');
  }

  async request(
    presence: DevicePresence,
    frame: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) throw new OutboundSessionCancelledError();
    if (presence.ownerReplicaId !== this.replicaId) {
      return this.bus.request(presence.ownerReplicaId, presence.sessionId, frame, signal);
    }
    const session = this.localSessions.get(presence.sessionId);
    if (
      !session ||
      session.sessionId !== presence.sessionId ||
      session.deviceId !== presence.deviceId
    ) {
      throw new OutboundSessionStaleError();
    }
    return session.request(frame, signal);
  }

  async cancel(presence: DevicePresence, frame: Uint8Array): Promise<void> {
    if (presence.ownerReplicaId !== this.replicaId) {
      await this.bus.send(presence.ownerReplicaId, presence.sessionId, frame);
      return;
    }
    const session = this.localSessions.get(presence.sessionId);
    if (
      !session ||
      session.sessionId !== presence.sessionId ||
      session.deviceId !== presence.deviceId
    ) {
      return;
    }
    await session.send(frame);
  }
}

export class OutboundSessionStaleError extends Error {}
export class OutboundSessionCancelledError extends Error {}
