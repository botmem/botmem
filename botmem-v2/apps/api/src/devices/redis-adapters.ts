import { SourceStatusSchema } from '@botmem-v2/contracts';
import type { LocalConnector } from './domain.js';
import type {
  DevicePresence,
  LocalOutboundSessionRegistryPort,
  PresenceDirectoryPort,
  RateLimitPort,
  ReplicaRequestBusPort,
  SecretGeneratorPort,
} from './ports.js';
import type {
  DeviceSourceStatusDirectoryPort,
  DeviceSourceStatusSnapshot,
} from './source-status.js';

export interface RedisClientPort {
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    options: { keys: readonly string[]; arguments: readonly string[] },
  ): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string, listener?: (message: string) => void): Promise<unknown>;
}

export interface RedisDeviceMetadataOptions {
  readonly namespace?: string;
  readonly maximumTtlMs?: number;
  readonly nowMs?: () => number;
}

/** TTL-only Redis metadata. No method accepts a query or search-result payload. */
export class RedisDeviceMetadataDirectory implements PresenceDirectoryPort, RateLimitPort {
  private readonly namespace: string;
  private readonly maximumTtlMs: number;
  private readonly nowMs: () => number;

  constructor(
    private readonly redis: RedisClientPort,
    options: RedisDeviceMetadataOptions = {},
  ) {
    this.namespace = validNamespace(options.namespace ?? 'botmem:v2');
    this.maximumTtlMs = options.maximumTtlMs ?? 5 * 60_000;
    this.nowMs = options.nowMs ?? Date.now;
    if (this.maximumTtlMs < 5_000 || this.maximumTtlMs > 60 * 60_000) {
      throw new RangeError('Redis metadata maximum TTL must be between 5 seconds and 1 hour');
    }
  }

  async upsert(presence: DevicePresence): Promise<void> {
    const ttlMs = this.ttl(presence.expiresAtMs);
    await this.redis.eval(UPSERT_INDEXED_METADATA_SCRIPT, {
      keys: [
        this.presenceKey(presence.workspaceId, presence.deviceId),
        this.presenceIndexKey(presence.workspaceId),
      ],
      arguments: [
        JSON.stringify(presence),
        String(ttlMs),
        String(presence.expiresAtMs),
        presence.deviceId,
        String(this.maximumTtlMs),
      ],
    });
  }

  async removeIfCurrent(workspaceId: string, deviceId: string, sessionId: string): Promise<void> {
    validateUuid(workspaceId);
    validateUuid(deviceId);
    validateUuid(sessionId);
    await this.redis.eval(REMOVE_CURRENT_SCRIPT, {
      keys: [this.presenceKey(workspaceId, deviceId), this.presenceIndexKey(workspaceId)],
      arguments: [sessionId, deviceId],
    });
  }

  async get(workspaceId: string, deviceId: string): Promise<DevicePresence | undefined> {
    const value = await this.redis.get(this.presenceKey(workspaceId, deviceId));
    return value ? parsePresence(value, this.nowMs()) : undefined;
  }

  async list(workspaceId: string): Promise<readonly DevicePresence[]> {
    validateUuid(workspaceId);
    const members = await this.activeMembers(this.presenceIndexKey(workspaceId));
    const values = await Promise.all(
      members.map((deviceId) => this.redis.get(this.presenceKey(workspaceId, deviceId))),
    );
    return values
      .filter((value): value is string => value !== null)
      .map((value) => parsePresence(value, this.nowMs()))
      .filter((value): value is DevicePresence => value !== undefined)
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  async upsertSourceStatus(
    snapshot: DeviceSourceStatusSnapshot & {
      readonly sessionId: string;
      readonly sessionGeneration: number;
    },
  ): Promise<void> {
    const ttlMs = this.ttl(snapshot.expiresAtMs);
    await this.redis.eval(UPSERT_INDEXED_METADATA_SCRIPT, {
      keys: [
        this.statusKey(snapshot.workspaceId, snapshot.deviceId),
        this.statusIndexKey(snapshot.workspaceId),
      ],
      arguments: [
        JSON.stringify(snapshot),
        String(ttlMs),
        String(snapshot.expiresAtMs),
        snapshot.deviceId,
        String(this.maximumTtlMs),
      ],
    });
  }

  async removeSourceStatusIfCurrent(
    workspaceId: string,
    deviceId: string,
    sessionId: string,
  ): Promise<void> {
    await this.redis.eval(REMOVE_STATUS_FOR_SESSION_SCRIPT, {
      keys: [this.statusKey(workspaceId, deviceId), this.statusIndexKey(workspaceId)],
      arguments: [sessionId, deviceId],
    });
  }

  async consume(input: {
    key: string;
    limit: number;
    windowMs: number;
    nowMs: number;
  }): Promise<boolean> {
    if (!/^[A-Za-z0-9:._-]{1,512}$/u.test(input.key)) throw new TypeError('rate key is invalid');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new RangeError('rate limit is invalid');
    }
    if (
      !Number.isSafeInteger(input.windowMs) ||
      input.windowMs < 1 ||
      input.windowMs > 86_400_000
    ) {
      throw new RangeError('rate window is invalid');
    }
    const result = await this.redis.eval(RATE_LIMIT_SCRIPT, {
      keys: [`${this.namespace}:rate:${input.key}`],
      arguments: [String(input.windowMs), String(input.limit)],
    });
    return Number(result) === 1;
  }

  /** Implements the read port while keeping the presence and status keyspaces separate. */
  async listStatuses(workspaceId: string): Promise<readonly DeviceSourceStatusSnapshot[]> {
    validateUuid(workspaceId);
    const members = await this.activeMembers(this.statusIndexKey(workspaceId));
    const values = await Promise.all(
      members.map((deviceId) => this.redis.get(this.statusKey(workspaceId, deviceId))),
    );
    return values
      .filter((value): value is string => value !== null)
      .map((value) => parseSourceStatus(value, this.nowMs()))
      .filter((value): value is DeviceSourceStatusSnapshot => value !== undefined)
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  private async activeMembers(indexKey: string): Promise<readonly string[]> {
    const result = await this.redis.eval(LIST_ACTIVE_METADATA_SCRIPT, {
      keys: [indexKey],
      arguments: [String(this.nowMs())],
    });
    if (!Array.isArray(result) || !result.every((value) => typeof value === 'string')) {
      throw new RedisMetadataProtocolError();
    }
    return result;
  }

  private ttl(expiresAtMs: number): number {
    const ttl = Math.min(expiresAtMs - this.nowMs(), this.maximumTtlMs);
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new RangeError('metadata expiry is invalid');
    return ttl;
  }

  private presenceKey(workspaceId: string, deviceId: string): string {
    validateUuid(workspaceId);
    validateUuid(deviceId);
    return `${this.namespace}:presence:${workspaceId}:${deviceId}`;
  }

  private presenceIndexKey(workspaceId: string): string {
    validateUuid(workspaceId);
    return `${this.namespace}:presence-index:${workspaceId}`;
  }

  private statusKey(workspaceId: string, deviceId: string): string {
    validateUuid(workspaceId);
    validateUuid(deviceId);
    return `${this.namespace}:source-status:${workspaceId}:${deviceId}`;
  }

  private statusIndexKey(workspaceId: string): string {
    validateUuid(workspaceId);
    return `${this.namespace}:source-status-index:${workspaceId}`;
  }
}

/** Narrow status view prevents the similarly named presence list from leaking through. */
export class RedisDeviceSourceStatusDirectory implements DeviceSourceStatusDirectoryPort {
  constructor(private readonly metadata: RedisDeviceMetadataDirectory) {}
  list(workspaceId: string): Promise<readonly DeviceSourceStatusSnapshot[]> {
    return this.metadata.listStatuses(workspaceId);
  }
  upsert(
    snapshot: DeviceSourceStatusSnapshot & {
      readonly sessionId: string;
      readonly sessionGeneration: number;
    },
  ): Promise<void> {
    return this.metadata.upsertSourceStatus(snapshot);
  }
  removeIfCurrent(workspaceId: string, deviceId: string, sessionId: string): Promise<void> {
    return this.metadata.removeSourceStatusIfCurrent(workspaceId, deviceId, sessionId);
  }
}

interface RequestEnvelope {
  readonly version: 2;
  readonly kind: 'request';
  readonly correlationId: string;
  readonly sessionId: string;
  readonly replyChannel: string;
  readonly frame: string;
}

interface SendEnvelope {
  readonly version: 2;
  readonly kind: 'send';
  readonly sessionId: string;
  readonly frame: string;
}

interface ResponseEnvelope {
  readonly version: 2;
  readonly correlationId: string;
  readonly ok: boolean;
  readonly frame?: string;
}

export interface RedisReplicaRequestBusOptions {
  readonly namespace?: string;
  readonly requestTimeoutMs?: number;
  readonly maximumFrameBytes?: number;
}

/**
 * At-most-once Redis Pub/Sub relay. It intentionally uses no Streams, lists,
 * payload keys, or replay mechanism, so frames exist only in process/in transit.
 */
export class RedisReplicaRequestBus implements ReplicaRequestBusPort {
  private readonly namespace: string;
  private readonly requestTimeoutMs: number;
  private readonly maximumFrameBytes: number;
  private listening = false;

  constructor(
    private readonly replicaId: string,
    private readonly publisher: RedisClientPort,
    private readonly subscriber: RedisClientPort,
    private readonly sessions: LocalOutboundSessionRegistryPort,
    private readonly ids: SecretGeneratorPort,
    options: RedisReplicaRequestBusOptions = {},
  ) {
    this.namespace = validNamespace(options.namespace ?? 'botmem:v2');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maximumFrameBytes = options.maximumFrameBytes ?? 1_048_576;
    validateReplicaId(replicaId);
    if (this.requestTimeoutMs < 1 || this.requestTimeoutMs > 30_000) {
      throw new RangeError('replica request timeout is invalid');
    }
  }

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.subscriber.subscribe(this.requestChannel(this.replicaId), (message) => {
      void this.handleInbound(message);
    });
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await this.subscriber.unsubscribe(this.requestChannel(this.replicaId));
  }

  async request(
    ownerReplicaId: string,
    sessionId: string,
    frame: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertFrame(frame);
    validateReplicaId(ownerReplicaId);
    validateUuid(sessionId);
    if (signal.aborted) throw new ReplicaRelayCancelledError();
    const correlationId = this.ids.uuid();
    const replyChannel = `${this.namespace}:relay:reply:${this.replicaId}:${correlationId}`;
    const envelope: RequestEnvelope = {
      version: 2,
      kind: 'request',
      correlationId,
      sessionId,
      replyChannel,
      frame: Buffer.from(frame).toString('base64'),
    };

    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        void this.subscriber.unsubscribe(replyChannel, onMessage);
        if (error) reject(error);
        else resolve(value ?? new Uint8Array());
      };
      const onAbort = () => finish(new ReplicaRelayCancelledError());
      const onMessage = (message: string) => {
        try {
          if (message.length > Math.ceil((this.maximumFrameBytes * 4) / 3) + 1_024) {
            throw new ReplicaRelayFrameSizeError();
          }
          const response = parseResponseEnvelope(message, correlationId);
          if (!response.ok || !response.frame) {
            finish(new ReplicaRelayUnavailableError());
            return;
          }
          const bytes = this.decodeFrame(response.frame);
          finish(undefined, bytes);
        } catch {
          finish(new ReplicaRelayProtocolError());
        }
      };
      const timer = setTimeout(() => finish(new ReplicaRelayTimeoutError()), this.requestTimeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      void this.subscriber
        .subscribe(replyChannel, onMessage)
        .then(() =>
          this.publisher.publish(this.requestChannel(ownerReplicaId), JSON.stringify(envelope)),
        )
        .then((receivers) => {
          if (receivers < 1) finish(new ReplicaRelayUnavailableError());
        })
        .catch(() => finish(new ReplicaRelayUnavailableError()));
    });
  }

  async send(ownerReplicaId: string, sessionId: string, frame: Uint8Array): Promise<void> {
    this.assertFrame(frame);
    validateReplicaId(ownerReplicaId);
    validateUuid(sessionId);
    const envelope: SendEnvelope = {
      version: 2,
      kind: 'send',
      sessionId,
      frame: Buffer.from(frame).toString('base64'),
    };
    await this.publisher.publish(this.requestChannel(ownerReplicaId), JSON.stringify(envelope));
  }

  private async handleInbound(message: string): Promise<void> {
    let parsed: RequestEnvelope | SendEnvelope;
    try {
      if (message.length > Math.ceil((this.maximumFrameBytes * 4) / 3) + 2_048) {
        throw new ReplicaRelayFrameSizeError();
      }
      parsed = parseInboundEnvelope(message);
      validateUuid(parsed.sessionId);
      if (parsed.kind === 'request') {
        validateUuid(parsed.correlationId);
        this.assertReplyChannel(parsed.replyChannel, parsed.correlationId);
      }
      const bytes = this.decodeFrame(parsed.frame);
      const session = this.sessions.get(parsed.sessionId);
      if (!session || session.sessionId !== parsed.sessionId) {
        if (parsed.kind === 'request') await this.respond(parsed, false);
        return;
      }
      if (parsed.kind === 'send') {
        await session.send(bytes);
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await session.request(bytes, controller.signal);
        this.assertFrame(response);
        await this.respond(parsed, true, response);
      } catch {
        await this.respond(parsed, false);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Malformed transport input is dropped without logging its contents.
    }
  }

  private async respond(request: RequestEnvelope, ok: boolean, frame?: Uint8Array): Promise<void> {
    const response: ResponseEnvelope = {
      version: 2,
      correlationId: request.correlationId,
      ok,
      ...(frame ? { frame: Buffer.from(frame).toString('base64') } : {}),
    };
    await this.publisher.publish(request.replyChannel, JSON.stringify(response));
  }

  private requestChannel(replicaId: string): string {
    return `${this.namespace}:relay:request:${replicaId}`;
  }

  private assertFrame(frame: Uint8Array): void {
    if (frame.byteLength < 1 || frame.byteLength > this.maximumFrameBytes) {
      throw new ReplicaRelayFrameSizeError();
    }
  }

  private decodeFrame(value: string): Uint8Array {
    if (
      value.length < 1 ||
      value.length > Math.ceil((this.maximumFrameBytes * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    ) {
      throw new ReplicaRelayFrameSizeError();
    }
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    this.assertFrame(bytes);
    return bytes;
  }

  private assertReplyChannel(channel: string, correlationId: string): void {
    const prefix = `${this.namespace}:relay:reply:`;
    if (!channel.startsWith(prefix) || channel.length > prefix.length + 165) {
      throw new ReplicaRelayProtocolError();
    }
    const parts = channel.slice(prefix.length).split(':');
    if (parts.length !== 2 || parts[1] !== correlationId) {
      throw new ReplicaRelayProtocolError();
    }
    validateReplicaId(parts[0] ?? '');
  }
}

const REMOVE_CURRENT_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local decoded = cjson.decode(value)
if decoded.sessionId ~= ARGV[1] then return 0 end
redis.call('ZREM', KEYS[2], ARGV[2])
return redis.call('DEL', KEYS[1])`;

const REMOVE_STATUS_FOR_SESSION_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local decoded = cjson.decode(value)
if decoded.sessionId ~= ARGV[1] then return 0 end
redis.call('ZREM', KEYS[2], ARGV[2])
return redis.call('DEL', KEYS[1])`;

const UPSERT_INDEXED_METADATA_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local current = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if current.sessionId ~= incoming.sessionId and
     tonumber(current.sessionGeneration or 0) >= tonumber(incoming.sessionGeneration or 0) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1`;

const LIST_ACTIVE_METADATA_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')`;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if current <= tonumber(ARGV[2]) then return 1 end
return 0`;

function parsePresence(value: string, nowMs: number): DevicePresence | undefined {
  const parsed = JSON.parse(value) as Partial<DevicePresence>;
  if (
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.workspaceId !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.ownerReplicaId !== 'string' ||
    !Array.isArray(parsed.connectors) ||
    !parsed.connectors.every(isLocalConnector) ||
    !isAvailability(parsed.availability) ||
    typeof parsed.expiresAtMs !== 'number' ||
    parsed.expiresAtMs <= nowMs
  ) {
    return undefined;
  }
  return parsed as DevicePresence;
}

function parseSourceStatus(value: string, nowMs: number): DeviceSourceStatusSnapshot | undefined {
  const parsed = JSON.parse(value) as Partial<DeviceSourceStatusSnapshot>;
  if (
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.workspaceId !== 'string' ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.expiresAtMs !== 'number' ||
    parsed.expiresAtMs <= nowMs ||
    !Array.isArray(parsed.sources) ||
    !parsed.sources.every(
      (source) =>
        SourceStatusSchema.safeParse(source).success &&
        (source.connector === 'imessage' || source.connector === 'whatsapp'),
    )
  ) {
    return undefined;
  }
  return parsed as DeviceSourceStatusSnapshot;
}

function parseInboundEnvelope(value: string): RequestEnvelope | SendEnvelope {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.version !== 2 ||
    (parsed.kind !== 'request' && parsed.kind !== 'send') ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.frame !== 'string'
  ) {
    throw new ReplicaRelayProtocolError();
  }
  if (
    parsed.kind === 'request' &&
    (typeof parsed.correlationId !== 'string' || typeof parsed.replyChannel !== 'string')
  ) {
    throw new ReplicaRelayProtocolError();
  }
  return parsed as unknown as RequestEnvelope | SendEnvelope;
}

function parseResponseEnvelope(value: string, correlationId: string): ResponseEnvelope {
  const parsed = JSON.parse(value) as Partial<ResponseEnvelope>;
  if (
    parsed.version !== 2 ||
    parsed.correlationId !== correlationId ||
    typeof parsed.ok !== 'boolean' ||
    (parsed.frame !== undefined && typeof parsed.frame !== 'string')
  ) {
    throw new ReplicaRelayProtocolError();
  }
  return parsed as ResponseEnvelope;
}

function validNamespace(value: string): string {
  if (!/^[A-Za-z0-9:._-]{1,128}$/u.test(value)) throw new TypeError('Redis namespace is invalid');
  return value;
}

function validateUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('UUID is invalid');
  }
}

function validateReplicaId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new TypeError('replica ID is invalid');
}

function isLocalConnector(value: unknown): value is LocalConnector {
  return value === 'imessage' || value === 'whatsapp';
}

function isAvailability(value: unknown): value is DevicePresence['availability'] {
  return value === 'ready' || value === 'offline' || value === 'failed';
}

export class ReplicaRelayUnavailableError extends Error {}
export class ReplicaRelayTimeoutError extends Error {}
export class ReplicaRelayCancelledError extends Error {}
export class ReplicaRelayProtocolError extends Error {}
export class ReplicaRelayFrameSizeError extends Error {}
export class RedisMetadataProtocolError extends Error {}
