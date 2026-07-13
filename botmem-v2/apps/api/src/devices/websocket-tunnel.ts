import websocket from '@fastify/websocket';
import {
  DEVICE_PROTOCOL,
  DeviceFrameSchema,
  MAX_DEVICE_FRAME_BYTES,
  parseDeviceFrame,
  parseWorkspaceId,
  type DeviceFrame,
} from '@botmem-v2/contracts';
import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { DeviceAuthenticationService } from './authentication-service.js';
import type { DeviceSnapshot, LocalConnector } from './domain.js';
import type {
  DevicePresence,
  DeviceRegistryPort,
  DigestPort,
  LocalOutboundSessionRegistryPort,
  OutboundDeviceSessionPort,
  PresenceDirectoryPort,
  RateLimitPort,
  SecretGeneratorPort,
} from './ports.js';
import type { RedisDeviceSourceStatusDirectory } from './redis-adapters.js';

interface WorkspaceParams {
  readonly workspaceId: string;
}

export interface DeviceTunnelDependencies {
  readonly replicaId: string;
  readonly devices: DeviceRegistryPort;
  readonly authentication: DeviceAuthenticationService;
  readonly presence: PresenceDirectoryPort;
  readonly rateLimit: RateLimitPort;
  readonly digest: DigestPort;
  readonly sourceStatuses: RedisDeviceSourceStatusDirectory;
  readonly sessions: InMemoryOutboundSessionRegistry;
  readonly ids: SecretGeneratorPort;
  readonly nowMs?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly handshakeTimeoutMs?: number;
}

/** Registers the WebSocket plugin before declaring the tunnel route. */
export async function registerDeviceTunnel(
  app: FastifyInstance,
  dependencies: DeviceTunnelDependencies,
): Promise<void> {
  await app.register(websocket, {
    options: { maxPayload: MAX_DEVICE_FRAME_BYTES },
  });
  registerDeviceTunnelRoute(app, dependencies);
}

export function registerDeviceTunnelRoute(
  app: FastifyInstance,
  dependencies: DeviceTunnelDependencies,
): void {
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 20_000;
  const handshakeTimeoutMs = dependencies.handshakeTimeoutMs ?? 15_000;
  if (heartbeatIntervalMs < 5_000 || heartbeatIntervalMs > 120_000) {
    throw new RangeError('heartbeat interval is invalid');
  }
  if (handshakeTimeoutMs < 1_000 || handshakeTimeoutMs > 60_000) {
    throw new RangeError('handshake timeout is invalid');
  }
  validateReplicaId(dependencies.replicaId);
  const nowMs = dependencies.nowMs ?? Date.now;

  app.get<{ Params: WorkspaceParams }>(
    '/v2/workspaces/:workspaceId/device-tunnel',
    { websocket: true },
    (socket, request) => {
      // Attach synchronously so no early client frames are lost.
      let state: TunnelState = { phase: 'hello' };
      let session: LiveOutboundDeviceSession | undefined;
      let processing = Promise.resolve();
      const handshakeTimer = setTimeout(
        () => socket.close(1008, 'handshake_timeout'),
        handshakeTimeoutMs,
      );

      const onMessage = (data: RawData) => {
        processing = processing
          .then(async () => {
            const frame = parseSocketFrame(data, nowMs());
            if (state.phase === 'hello') {
              if (frame.type !== 'hello') throw new TunnelProtocolError();
              const allowed = await dependencies.rateLimit.consume({
                key: `device-tunnel:${(
                  await dependencies.digest.sha256(new TextEncoder().encode(request.ip))
                ).slice(0, 32)}`,
                limit: 120,
                windowMs: 10 * 60_000,
                nowMs: nowMs(),
              });
              if (!allowed) throw new TunnelAuthenticationError();
              const workspaceId = parseWorkspaceId(request.params.workspaceId);
              const owner = { tenantId: workspaceId, workspaceId };
              const device = await dependencies.devices.get(owner, frame.payload.deviceId);
              if (!device || device.status !== 'active') throw new TunnelAuthenticationError();
              const challenge = await dependencies.authentication.issueChallenge({
                ...owner,
                deviceId: device.deviceId,
                keyId: device.keyId,
                clientNonce: frame.payload.nonce,
              });
              state = {
                phase: 'authenticate',
                workspaceId,
                device,
                clientVersion: frame.payload.clientVersion,
                clientNonce: frame.payload.nonce,
                serverNonce: challenge.serverNonce,
              };
              await sendFrame(
                socket,
                responseFrame(dependencies.ids, nowMs(), 'challenge', {
                  nonce: frame.payload.nonce,
                  serverNonce: challenge.serverNonce,
                }),
              );
              return;
            }
            if (state.phase === 'authenticate') {
              if (
                frame.type !== 'authenticate' ||
                frame.payload.deviceId !== state.device.deviceId ||
                frame.payload.keyId !== state.device.keyId
              ) {
                throw new TunnelAuthenticationError();
              }
              const credential = await dependencies.authentication.authenticate({
                tenantId: state.device.tenantId,
                workspaceId: state.workspaceId,
                deviceId: state.device.deviceId,
                keyId: state.device.keyId,
                clientNonce: state.clientNonce,
                serverNonce: state.serverNonce,
                signatureBase64Url: frame.payload.signature,
              });
              const credentialExpiresAtMs = Date.parse(credential.expiresAt);
              if (!Number.isFinite(credentialExpiresAtMs) || credentialExpiresAtMs <= nowMs()) {
                throw new TunnelAuthenticationError();
              }
              session = new LiveOutboundDeviceSession({
                socket,
                sessionId: credential.value,
                sessionGeneration: credential.generation,
                device: state.device,
                clientVersion: state.clientVersion,
                replicaId: dependencies.replicaId,
                heartbeatIntervalMs,
                presence: dependencies.presence,
                sourceStatuses: dependencies.sourceStatuses,
                nowMs,
                credentialExpiresAtMs,
              });
              dependencies.sessions.register(session);
              await session.refreshPresence('offline', 'capabilities_pending');
              state = { phase: 'active', session };
              clearTimeout(handshakeTimer);
              await sendFrame(
                socket,
                responseFrame(dependencies.ids, nowMs(), 'authenticated', {
                  sessionId: credential.value,
                  heartbeatIntervalMs,
                  credentialExpiresAt: credential.expiresAt,
                }),
              );
              return;
            }
            await state.session.accept(frame);
          })
          .catch((error) => {
            const code = error instanceof TunnelFrameTooLargeError ? 1009 : 1008;
            socket.close(code, 'protocol_error');
          });
      };

      socket.on('message', onMessage);
      socket.once('close', () => {
        clearTimeout(handshakeTimer);
        if (session) {
          dependencies.sessions.unregister(session);
          void session.closed().catch(() => undefined);
        }
      });
      socket.once('error', () => {
        // The close path performs cleanup. Socket errors may include frame data,
        // so this boundary deliberately does not log the error object.
      });
    },
  );
}

type TunnelState =
  | { readonly phase: 'hello' }
  | {
      readonly phase: 'authenticate';
      readonly workspaceId: string;
      readonly device: DeviceSnapshot;
      readonly clientVersion: string;
      readonly clientNonce: string;
      readonly serverNonce: string;
    }
  | { readonly phase: 'active'; readonly session: LiveOutboundDeviceSession };

interface LiveSessionOptions {
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly device: DeviceSnapshot;
  readonly clientVersion: string;
  readonly replicaId: string;
  readonly heartbeatIntervalMs: number;
  readonly presence: PresenceDirectoryPort;
  readonly sourceStatuses: RedisDeviceSourceStatusDirectory;
  readonly nowMs: () => number;
  readonly credentialExpiresAtMs: number;
}

export class LiveOutboundDeviceSession implements OutboundDeviceSessionPort {
  readonly sessionId: string;
  readonly deviceId: string;
  private readonly pending = new Map<
    string,
    { resolve(value: Uint8Array): void; reject(error: unknown): void; cleanup(): void }
  >();
  private connectors: readonly LocalConnector[] = [];
  private lastHeartbeatSequence = -1;
  private closedState = false;
  private credentialExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupPromise: Promise<void> | undefined;

  constructor(private readonly options: LiveSessionOptions) {
    this.sessionId = options.sessionId;
    this.deviceId = options.device.deviceId;
    const lifetimeMs = options.credentialExpiresAtMs - options.nowMs();
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 24 * 60 * 60_000) {
      throw new TunnelAuthenticationError();
    }
    this.credentialExpiryTimer = setTimeout(() => void this.expireCredential(), lifetimeMs);
  }

  async request(frameBytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (this.closedState || this.options.socket.readyState !== 1) throw new TunnelClosedError();
    const frame = parseDeviceFrame(frameBytes);
    if (frame.type !== 'search.request') throw new TunnelProtocolError();
    if (this.pending.size >= 32) throw new TunnelCapacityError();
    if (this.pending.has(frame.payload.queryId)) throw new TunnelProtocolError();
    if (signal.aborted) throw new TunnelCancelledError();
    const deadlineMs = Math.max(1, Date.parse(frame.deadlineAt) - this.options.nowMs());
    return new Promise<Uint8Array>((resolve, reject) => {
      const queryId = frame.payload.queryId;
      const onAbort = () => finish(new TunnelCancelledError());
      const timeout = setTimeout(() => finish(new TunnelRequestTimeoutError()), deadlineMs);
      const finish = (error?: unknown, value?: Uint8Array) => {
        const current = this.pending.get(queryId);
        if (!current) return;
        this.pending.delete(queryId);
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? new Uint8Array());
      };
      this.pending.set(queryId, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
        cleanup: () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      void sendBytes(this.options.socket, frameBytes).catch((error) => finish(error));
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.closedState || this.options.socket.readyState !== 1) return Promise.resolve();
    const parsed = parseDeviceFrame(frame);
    await sendBytes(this.options.socket, frame);
    if (parsed.type === 'revoke') this.close(parsed.payload.reasonCode);
  }

  async accept(frame: DeviceFrame): Promise<void> {
    if (this.closedState) throw new TunnelClosedError();
    if (frame.type === 'capabilities') {
      const declared = [...new Set(frame.payload.connectors)].sort() as LocalConnector[];
      if (
        declared.length < 1 ||
        declared.some((connector) => !this.options.device.connectors.includes(connector)) ||
        !frame.payload.rpc.includes('source.status') ||
        !frame.payload.rpc.includes('search.query') ||
        !frame.payload.rpc.includes('search.cancel')
      ) {
        throw new TunnelProtocolError();
      }
      this.connectors = declared;
      await this.refreshPresence('ready');
      return;
    }
    if (frame.type === 'heartbeat') {
      if (
        frame.payload.sessionId !== this.sessionId ||
        frame.payload.sequence <= this.lastHeartbeatSequence
      ) {
        throw new TunnelProtocolError();
      }
      this.lastHeartbeatSequence = frame.payload.sequence;
      await this.refreshPresence(
        this.connectors.length > 0 ? 'ready' : 'offline',
        this.connectors.length > 0 ? undefined : 'capabilities_pending',
      );
      return;
    }
    if (frame.type === 'source.status') {
      if (
        this.connectors.length < 1 ||
        frame.payload.sources.some(
          (source) => !this.connectors.includes(source.connector as LocalConnector),
        )
      ) {
        throw new TunnelProtocolError();
      }
      await this.options.sourceStatuses.upsert({
        tenantId: this.options.device.tenantId,
        workspaceId: this.options.device.workspaceId,
        deviceId: this.deviceId,
        sessionId: this.sessionId,
        sessionGeneration: this.options.sessionGeneration,
        expiresAtMs: this.expiresAtMs(),
        sources: frame.payload.sources,
      });
      if (this.closedState) {
        await this.options.sourceStatuses.removeIfCurrent(
          this.options.device.workspaceId,
          this.deviceId,
          this.sessionId,
        );
        throw new TunnelClosedError();
      }
      return;
    }
    if (frame.type === 'search.response') {
      const pending = this.pending.get(frame.payload.queryId);
      if (!pending) return;
      pending.resolve(new TextEncoder().encode(JSON.stringify(frame)));
      return;
    }
    if (frame.type === 'error') {
      return;
    }
    throw new TunnelProtocolError();
  }

  async refreshPresence(
    availability: DevicePresence['availability'],
    reasonCode?: string,
  ): Promise<void> {
    if (this.closedState) throw new TunnelClosedError();
    const lastSeenAtMs = this.options.nowMs();
    await this.options.presence.upsert({
      tenantId: this.options.device.tenantId,
      workspaceId: this.options.device.workspaceId,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      sessionGeneration: this.options.sessionGeneration,
      ownerReplicaId: this.options.replicaId,
      connectors: this.connectors.length > 0 ? this.connectors : this.options.device.connectors,
      availability,
      ...(reasonCode ? { reasonCode } : {}),
      clientVersion: this.options.clientVersion,
      lastSeenAtMs,
      expiresAtMs: this.expiresAtMs(lastSeenAtMs),
    });
    // Expiry can race a Redis write that was already in flight. Remove the
    // exact session again after that write so it cannot resurrect presence.
    if (this.closedState) {
      await this.options.presence.removeIfCurrent(
        this.options.device.workspaceId,
        this.deviceId,
        this.sessionId,
      );
      throw new TunnelClosedError();
    }
  }

  close(reason = 'session_replaced'): void {
    if (this.closedState) return;
    this.closedState = true;
    this.clearCredentialExpiry();
    this.options.socket.close(1008, reason);
    this.rejectPending();
  }

  async closed(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closedState = true;
    this.clearCredentialExpiry();
    this.rejectPending();
    this.cleanupPromise = Promise.all([
      this.options.presence.removeIfCurrent(
        this.options.device.workspaceId,
        this.deviceId,
        this.sessionId,
      ),
      this.options.sourceStatuses.removeIfCurrent(
        this.options.device.workspaceId,
        this.deviceId,
        this.sessionId,
      ),
    ]).then(() => undefined);
    return this.cleanupPromise;
  }

  private expiresAtMs(nowMs = this.options.nowMs()): number {
    return nowMs + this.options.heartbeatIntervalMs * 3;
  }

  private async expireCredential(): Promise<void> {
    if (this.closedState) return;
    try {
      this.close('credential_expired');
    } finally {
      await this.closed().catch(() => undefined);
    }
  }

  private clearCredentialExpiry(): void {
    if (this.credentialExpiryTimer === undefined) return;
    clearTimeout(this.credentialExpiryTimer);
    this.credentialExpiryTimer = undefined;
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new TunnelClosedError());
    }
    this.pending.clear();
  }
}

export class InMemoryOutboundSessionRegistry implements LocalOutboundSessionRegistryPort {
  private readonly bySession = new Map<string, LiveOutboundDeviceSession>();
  private readonly byDevice = new Map<string, LiveOutboundDeviceSession>();

  get(sessionId: string): LiveOutboundDeviceSession | undefined {
    return this.bySession.get(sessionId);
  }

  register(session: LiveOutboundDeviceSession): void {
    const previous = this.byDevice.get(session.deviceId);
    if (previous && previous.sessionId !== session.sessionId) {
      this.unregister(previous);
      previous.close();
    }
    this.bySession.set(session.sessionId, session);
    this.byDevice.set(session.deviceId, session);
  }

  unregister(session: LiveOutboundDeviceSession): void {
    if (this.bySession.get(session.sessionId) === session) {
      this.bySession.delete(session.sessionId);
    }
    if (this.byDevice.get(session.deviceId) === session) {
      this.byDevice.delete(session.deviceId);
    }
  }
}

function responseFrame<T extends 'challenge' | 'authenticated'>(
  ids: SecretGeneratorPort,
  nowMs: number,
  type: T,
  payload: Extract<DeviceFrame, { type: T }>['payload'],
): Extract<DeviceFrame, { type: T }> {
  return DeviceFrameSchema.parse({
    protocol: DEVICE_PROTOCOL,
    requestId: ids.uuid(),
    sentAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + 15_000).toISOString(),
    type,
    payload,
  }) as Extract<DeviceFrame, { type: T }>;
}

function parseSocketFrame(data: RawData, nowMs: number): DeviceFrame {
  const bytes = rawBytes(data);
  if (bytes.byteLength > MAX_DEVICE_FRAME_BYTES) throw new TunnelFrameTooLargeError();
  const frame = parseDeviceFrame(bytes);
  if (Date.parse(frame.deadlineAt) <= nowMs) throw new TunnelProtocolError();
  return frame;
}

function rawBytes(data: RawData): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function sendFrame(socket: WebSocket, frame: DeviceFrame): Promise<void> {
  return sendBytes(socket, new TextEncoder().encode(JSON.stringify(frame)));
}

function sendBytes(socket: WebSocket, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_DEVICE_FRAME_BYTES)
    return Promise.reject(new TunnelFrameTooLargeError());
  if (socket.readyState !== 1) return Promise.reject(new TunnelClosedError());
  return new Promise((resolve, reject) => {
    socket.send(bytes, (error) => (error ? reject(new TunnelClosedError()) : resolve()));
  });
}

function validateReplicaId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new TypeError('replica ID is invalid');
}

export class TunnelProtocolError extends Error {}
export class TunnelAuthenticationError extends Error {}
export class TunnelFrameTooLargeError extends Error {}
export class TunnelClosedError extends Error {}
export class TunnelCapacityError extends Error {}
export class TunnelCancelledError extends Error {}
export class TunnelRequestTimeoutError extends Error {}
