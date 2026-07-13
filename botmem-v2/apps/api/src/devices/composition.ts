import type { DevicesApplicationService } from '@botmem-v2/sdk';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { z } from 'zod';
import type { WorkspaceAuthorizer } from '../search-api.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import type { DeviceDeletionDeliveryPort } from '../lifecycle/ports.js';
import { DeviceAuthenticationService } from './authentication-service.js';
import { WebCryptoDeviceSecurity } from './crypto.js';
import { registerDeviceApi } from './device-api.js';
import { ReplicaNeutralDeviceRouter } from './device-router.js';
import { DeviceListService } from './device-service.js';
import { DevicePairingService } from './pairing-service.js';
import {
  PostgresDeviceCredentialLifecycle,
  PostgresDeviceSecurityRepository,
} from './postgres-adapters.js';
import {
  RedisDeviceMetadataDirectory,
  RedisDeviceSourceStatusDirectory,
  RedisReplicaRequestBus,
  type RedisClientPort,
} from './redis-adapters.js';
import type { RateLimitPort } from './ports.js';
import { OutboundSessionReplicaRpc } from './replica-rpc.js';
import { RoutedDeviceSessionRevoker } from './session-revocation.js';
import { DeviceSourceStatusReader, type SourceStatusReaderPort } from './source-status.js';
import { InMemoryOutboundSessionRegistry, registerDeviceTunnel } from './websocket-tunnel.js';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  REDIS_URL: z.string().trim().min(1),
  API_REPLICA_ID: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
  DEVICE_REDIS_NAMESPACE: z
    .string()
    .regex(/^[A-Za-z0-9:._-]{1,128}$/u)
    .default('botmem:v2'),
  DEVICE_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  DEVICE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(120_000).default(20_000),
  DEVICE_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  DEVICE_RELAY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(10_000),
});

export interface DeviceRuntimeConfig {
  readonly redisUrl: string;
  readonly replicaId: string;
  readonly redisNamespace: string;
  readonly credentialLifetimeMs: number;
  readonly heartbeatIntervalMs: number;
  readonly handshakeTimeoutMs: number;
  readonly relayTimeoutMs: number;
}

export interface DeviceRuntimeComposition {
  readonly devices: DevicesApplicationService;
  readonly pairing: DevicePairingService;
  readonly authentication: DeviceAuthenticationService;
  readonly router: ReplicaNeutralDeviceRouter;
  readonly sourceStatuses: SourceStatusReaderPort;
  readonly deletionDelivery: DeviceDeletionDeliveryPort;
  /** Shared Redis-backed quota store; keys and counters only, never queries. */
  readonly rateLimits: RateLimitPort;
  readonly isReady: () => Promise<boolean>;
  readonly close: () => Promise<void>;
  readonly register: (
    app: FastifyInstance,
    workspaceAuthorizer: WorkspaceAuthorizer,
    readAuthorizer?: WorkspaceAuthorizer,
  ) => Promise<void>;
}

export function parseDeviceRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DeviceRuntimeConfig {
  const raw = configSchema.parse(defined(environment));
  const redis = new URL(raw.REDIS_URL);
  if (redis.protocol !== 'redis:' && redis.protocol !== 'rediss:') {
    throw new DeviceRuntimeConfigError('REDIS_URL must use redis or rediss');
  }
  if (raw.NODE_ENV === 'production' && redis.protocol !== 'rediss:') {
    throw new DeviceRuntimeConfigError('REDIS_URL must use TLS in production');
  }
  return Object.freeze({
    redisUrl: raw.REDIS_URL,
    replicaId: raw.API_REPLICA_ID,
    redisNamespace: raw.DEVICE_REDIS_NAMESPACE,
    credentialLifetimeMs: raw.DEVICE_CREDENTIAL_TTL_SECONDS * 1_000,
    heartbeatIntervalMs: raw.DEVICE_HEARTBEAT_INTERVAL_MS,
    handshakeTimeoutMs: raw.DEVICE_HANDSHAKE_TIMEOUT_MS,
    relayTimeoutMs: raw.DEVICE_RELAY_TIMEOUT_MS,
  });
}

/** Production composition: PostgreSQL identity, Redis metadata/relay, outbound WS. */
export async function composeDeviceRuntime(input: {
  readonly pool: SqlPoolPort;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<DeviceRuntimeComposition> {
  const config = parseDeviceRuntimeConfig(input.environment);
  const commandClient = createClient({
    url: config.redisUrl,
    socket: { connectTimeout: 5_000 },
  });
  commandClient.on('error', () => {
    // Composition-level operational reporting may increment a reason-code-only
    // metric. Driver errors are not logged because they can echo message data.
  });
  const subscriberClient = commandClient.duplicate();
  subscriberClient.on('error', () => undefined);
  try {
    await Promise.all([commandClient.connect(), subscriberClient.connect()]);
  } catch (error) {
    await Promise.allSettled([safeQuit(commandClient), safeQuit(subscriberClient)]);
    throw error;
  }

  const command = new NodeRedisClientAdapter(commandClient);
  const subscriber = new NodeRedisClientAdapter(subscriberClient);
  const clock = { nowMs: () => Date.now() };
  const security = new WebCryptoDeviceSecurity();
  const repository = new PostgresDeviceSecurityRepository(input.pool);
  const credentials = new PostgresDeviceCredentialLifecycle(
    input.pool,
    security,
    clock,
    config.credentialLifetimeMs,
  );
  const metadata = new RedisDeviceMetadataDirectory(command, {
    namespace: config.redisNamespace,
    maximumTtlMs: config.heartbeatIntervalMs * 3,
  });
  const sourceStatusDirectory = new RedisDeviceSourceStatusDirectory(metadata);
  const sessions = new InMemoryOutboundSessionRegistry();
  const bus = new RedisReplicaRequestBus(
    config.replicaId,
    command,
    subscriber,
    sessions,
    security,
    {
      namespace: config.redisNamespace,
      requestTimeoutMs: config.relayTimeoutMs,
    },
  );
  await bus.start();
  const rpc = new OutboundSessionReplicaRpc(config.replicaId, sessions, bus);
  const sessionRevoker = new RoutedDeviceSessionRevoker(metadata, rpc, security, clock);
  const authentication = new DeviceAuthenticationService(
    repository,
    repository,
    credentials,
    metadata,
    security,
    security,
    security,
    clock,
  );
  const pairing = new DevicePairingService(
    repository,
    repository,
    metadata,
    security,
    security,
    clock,
  );
  const devices = new DeviceListService(repository, metadata, sourceStatusDirectory);
  const router = new ReplicaNeutralDeviceRouter(
    repository,
    metadata,
    rpc,
    clock,
    security,
    config.relayTimeoutMs,
  );
  const sourceStatuses = new DeviceSourceStatusReader(repository, sourceStatusDirectory, Date.now);

  let closed = false;
  return Object.freeze({
    devices,
    pairing,
    authentication,
    router,
    sourceStatuses,
    rateLimits: metadata,
    deletionDelivery: {
      deliver: async (notice: Parameters<DeviceDeletionDeliveryPort['deliver']>[0]) => {
        const current = await metadata.get(notice.workspaceId, notice.deviceId);
        if (!current || current.tenantId !== notice.tenantId) return 'unreachable';
        await sessionRevoker.revoke(notice.workspaceId, notice.deviceId, 'device_deleted');
        return 'delivered';
      },
    },
    isReady: async () => {
      if (!commandClient.isOpen || !subscriberClient.isOpen) return false;
      return Promise.race([
        commandClient
          .ping()
          .then((value) => value === 'PONG')
          .catch(() => false),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
    },
    register: async (
      app: FastifyInstance,
      workspaceAuthorizer: WorkspaceAuthorizer,
      readAuthorizer?: WorkspaceAuthorizer,
    ) => {
      await registerDeviceTunnel(app, {
        replicaId: config.replicaId,
        devices: repository,
        authentication,
        presence: metadata,
        rateLimit: metadata,
        digest: security,
        sourceStatuses: sourceStatusDirectory,
        sessions,
        ids: security,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        handshakeTimeoutMs: config.handshakeTimeoutMs,
      });
      registerDeviceApi(app, {
        devices,
        pairing,
        authentication,
        workspaceAuthorizer,
        ...(readAuthorizer ? { readAuthorizer } : {}),
        sessionRevoker,
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await bus.close().catch(() => undefined);
      await Promise.allSettled([safeQuit(subscriberClient), safeQuit(commandClient)]);
    },
  });
}

export class NodeRedisClientAdapter implements RedisClientPort {
  constructor(private readonly client: RedisClientType) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  eval(
    script: string,
    options: { keys: readonly string[]; arguments: readonly string[] },
  ): Promise<unknown> {
    return this.client.eval(script, {
      keys: [...options.keys],
      arguments: [...options.arguments],
    });
  }

  publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  subscribe(channel: string, listener: (message: string) => void): Promise<unknown> {
    return this.client.subscribe(channel, listener);
  }

  unsubscribe(channel: string, listener?: (message: string) => void): Promise<unknown> {
    return this.client.unsubscribe(channel, listener);
  }
}

async function safeQuit(client: RedisClientType): Promise<void> {
  if (client.isOpen) await client.quit();
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export class DeviceRuntimeConfigError extends Error {}
