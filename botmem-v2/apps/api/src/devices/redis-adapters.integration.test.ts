import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebCryptoDeviceSecurity } from './crypto.js';
import { NodeRedisClientAdapter } from './composition.js';
import type { LocalOutboundSessionRegistryPort, OutboundDeviceSessionPort } from './ports.js';
import { RedisDeviceMetadataDirectory, RedisReplicaRequestBus } from './redis-adapters.js';

const configuredRedisUrl = process.env['BOTMEM_V2_DEVICE_TEST_REDIS_URL'];
const REDIS_URL = configuredRedisUrl ?? 'redis://127.0.0.1:6379';
const enabled = Boolean(configuredRedisUrl);

describe.runIf(enabled)('real Redis device metadata and replica relay', () => {
  const namespace = `botmem:v2:test:${crypto.randomUUID()}`;
  const commandClient = createClient({ url: REDIS_URL });
  const subscriberAClient = commandClient.duplicate();
  const subscriberBClient = commandClient.duplicate();
  const command = new NodeRedisClientAdapter(commandClient);
  const subscriberA = new NodeRedisClientAdapter(subscriberAClient);
  const subscriberB = new NodeRedisClientAdapter(subscriberBClient);
  const security = new WebCryptoDeviceSecurity();
  const respondingSession: OutboundDeviceSessionPort = {
    sessionId: '71000000-0000-4000-8000-000000000001',
    deviceId: '71000000-0000-4000-8000-000000000002',
    request: async (frame) => new Uint8Array([...frame].reverse()),
    send: async () => undefined,
  };
  const emptyRegistry: LocalOutboundSessionRegistryPort = { get: () => undefined };
  const respondingRegistry: LocalOutboundSessionRegistryPort = {
    get: (sessionId) => (sessionId === respondingSession.sessionId ? respondingSession : undefined),
  };
  const busA = new RedisReplicaRequestBus(
    'replica-a',
    command,
    subscriberA,
    emptyRegistry,
    security,
    { namespace, requestTimeoutMs: 2_000 },
  );
  const busB = new RedisReplicaRequestBus(
    'replica-b',
    command,
    subscriberB,
    respondingRegistry,
    security,
    { namespace, requestTimeoutMs: 2_000 },
  );

  beforeAll(async () => {
    await Promise.all([
      commandClient.connect(),
      subscriberAClient.connect(),
      subscriberBClient.connect(),
    ]);
    await Promise.all([busA.start(), busB.start()]);
  });

  afterAll(async () => {
    await Promise.all([busA.close(), busB.close()]);
    await commandClient.del([
      `${namespace}:presence-index:71000000-0000-4000-8000-000000000003`,
      `${namespace}:presence:71000000-0000-4000-8000-000000000003:${respondingSession.deviceId}`,
      `${namespace}:rate:auth:test`,
    ]);
    await Promise.all([subscriberAClient.quit(), subscriberBClient.quit(), commandClient.quit()]);
  });

  it('keeps presence TTL-bound and removes only the current session', async () => {
    const now = Date.now();
    const metadata = new RedisDeviceMetadataDirectory(command, {
      namespace,
      maximumTtlMs: 60_000,
      nowMs: () => now,
    });
    const presence = {
      tenantId: '71000000-0000-4000-8000-000000000003',
      workspaceId: '71000000-0000-4000-8000-000000000003',
      deviceId: respondingSession.deviceId,
      sessionId: respondingSession.sessionId,
      ownerReplicaId: 'replica-b',
      connectors: ['imessage'] as const,
      availability: 'ready' as const,
      lastSeenAtMs: now,
      expiresAtMs: now + 30_000,
    };
    await metadata.upsert(presence);
    expect(await metadata.get(presence.workspaceId, presence.deviceId)).toEqual(presence);
    await metadata.removeIfCurrent(
      presence.workspaceId,
      presence.deviceId,
      '71000000-0000-4000-8000-000000000099',
    );
    expect(await metadata.get(presence.workspaceId, presence.deviceId)).toBeDefined();
    await metadata.removeIfCurrent(presence.workspaceId, presence.deviceId, presence.sessionId);
    expect(await metadata.get(presence.workspaceId, presence.deviceId)).toBeUndefined();

    expect(
      await metadata.consume({ key: 'auth:test', limit: 1, windowMs: 30_000, nowMs: now }),
    ).toBe(true);
    expect(
      await metadata.consume({ key: 'auth:test', limit: 1, windowMs: 30_000, nowMs: now }),
    ).toBe(false);

    const newer = {
      ...presence,
      sessionId: '71000000-0000-4000-8000-000000000010',
      sessionGeneration: 10,
    };
    await metadata.upsert(newer);
    await metadata.upsert({
      ...presence,
      sessionId: '71000000-0000-4000-8000-000000000009',
      sessionGeneration: 9,
      lastSeenAtMs: now + 1_000,
    });
    expect(await metadata.get(presence.workspaceId, presence.deviceId)).toMatchObject({
      sessionId: newer.sessionId,
      sessionGeneration: 10,
    });
  });

  it('routes request/reply across replicas without creating Redis payload keys', async () => {
    const signal = new AbortController().signal;
    const response = await busA.request(
      'replica-b',
      respondingSession.sessionId,
      new Uint8Array([1, 2, 3, 4]),
      signal,
    );
    expect([...response]).toEqual([4, 3, 2, 1]);
    expect(await commandClient.keys(`${namespace}:relay:*`)).toEqual([]);
  });
});
