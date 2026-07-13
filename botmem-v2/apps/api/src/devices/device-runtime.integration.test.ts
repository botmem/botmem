import {
  DEVICE_PROTOCOL,
  DeviceFrameSchema,
  type DeviceFrame,
  type SearchRequest,
} from '@botmem-v2/contracts';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { createClient } from 'redis';
import type { RawData, WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceAuthorizationError } from '../search-api.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { authenticationMessage } from './authentication-service.js';
import { composeDeviceRuntime, type DeviceRuntimeComposition } from './composition.js';

const configuredDatabaseUrl = process.env['BOTMEM_V2_DEVICE_TEST_DATABASE_URL'];
const configuredRedisUrl = process.env['BOTMEM_V2_DEVICE_TEST_REDIS_URL'];
const enabled = Boolean(configuredDatabaseUrl && configuredRedisUrl);
const DATABASE_URL = configuredDatabaseUrl ?? 'postgresql://invalid/disabled';
const REDIS_URL = configuredRedisUrl ?? 'redis://127.0.0.1:6379';

describe.runIf(enabled)('real PostgreSQL + Redis + HTTP + outbound WebSocket runtime', () => {
  const workspaceId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const namespace = `botmem:v2:e2e:${crypto.randomUUID()}`;
  const pool = new NodePostgresPoolAdapter({ connectionString: DATABASE_URL, max: 8 });
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const app = Fastify({ logger: false });
  let runtime: DeviceRuntimeComposition;
  let socket: WebSocket | undefined;

  beforeAll(async () => {
    await admin.query(`TRUNCATE TABLE
      botmem.device_session_credential,
      botmem.device_auth_challenge,
      botmem.device_pairing_grant,
      botmem.device_registry CASCADE`);
    runtime = await composeDeviceRuntime({
      pool,
      environment: {
        NODE_ENV: 'test',
        REDIS_URL,
        API_REPLICA_ID: 'e2e-replica',
        DEVICE_REDIS_NAMESPACE: namespace,
        DEVICE_HEARTBEAT_INTERVAL_MS: '5000',
        DEVICE_CREDENTIAL_TTL_SECONDS: '300',
        DEVICE_RELAY_TIMEOUT_MS: '3000',
      },
    });
    await runtime.register(app, {
      authorize: async (requested, credentials) => {
        if (credentials.authorizationHeader !== 'Bearer e2e') {
          throw new WorkspaceAuthorizationError(
            401,
            'authentication_required',
            'Authentication required',
          );
        }
        return requested;
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    if (socket?.readyState === 1) {
      const closed = new Promise<void>((resolve) => socket?.once('close', () => resolve()));
      socket.close();
      await closed;
    }
    await app.close();
    await runtime?.close();
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    const tunnelIpHash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('127.0.0.1')),
    )
      .toString('hex')
      .slice(0, 32);
    await redis.del([
      `${namespace}:rate:pairing:issue:${workspaceId}:${workspaceId}`,
      `${namespace}:rate:pairing:redeem:${workspaceId}:${workspaceId}`,
      `${namespace}:rate:device-auth:${workspaceId}:${workspaceId}:${deviceId}`,
      `${namespace}:rate:device-tunnel:${tunnelIpHash}`,
    ]);
    await redis.quit();
    await pool.close();
    await admin.end();
  });

  it('pairs, authenticates a signed client, reports status, and searches end to end', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKeyBase64Url = Buffer.from(publicKey).toString('base64url');

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${workspaceId}/devices`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const pairingCodeResponse = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/devices/pairing-codes`,
      headers: { authorization: 'Bearer e2e' },
    });
    expect(pairingCodeResponse.statusCode).toBe(201);
    expect(pairingCodeResponse.headers['cache-control']).toBe('no-store');
    const pairingCode = pairingCodeResponse.json<{ code: string }>().code;

    const pairResponse = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/devices/pair`,
      payload: {
        code: pairingCode,
        deviceId,
        displayName: 'E2E Mac',
        keyId: 'e2e-key-1',
        publicKeyBase64Url,
        connectors: ['imessage'],
      },
    });
    expect(pairResponse.statusCode).toBe(201);
    expect(pairResponse.headers['cache-control']).toBe('no-store');
    expect(pairResponse.json()).toEqual({ deviceId, state: 'paired' });
    const replayResponse = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/devices/pair`,
      payload: {
        code: pairingCode,
        deviceId: crypto.randomUUID(),
        displayName: 'Replay Mac',
        keyId: 'e2e-key-replay',
        publicKeyBase64Url,
        connectors: ['imessage'],
      },
    });
    expect(replayResponse.statusCode).toBe(401);

    socket = await app.injectWS(`/v2/workspaces/${workspaceId}/device-tunnel`);
    const helloNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
      'base64url',
    );
    const challengePromise = nextFrame(socket);
    socket.send(
      JSON.stringify(
        frame('hello', {
          deviceId,
          clientVersion: '2.0.0-e2e',
          nonce: helloNonce,
        }),
      ),
    );
    const challenge = await challengePromise;
    expect(challenge.type).toBe('challenge');
    if (challenge.type !== 'challenge') throw new Error('challenge was not returned');

    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keyPair.privateKey,
        authenticationMessage({
          deviceId,
          keyId: 'e2e-key-1',
          clientNonce: helloNonce,
          serverNonce: challenge.payload.serverNonce,
        }),
      ),
    );
    const authenticatedPromise = nextFrame(socket);
    socket.send(
      JSON.stringify(
        frame('authenticate', {
          deviceId,
          keyId: 'e2e-key-1',
          signature: Buffer.from(signature).toString('base64url'),
        }),
      ),
    );
    const authenticated = await authenticatedPromise;
    expect(authenticated.type).toBe('authenticated');
    if (authenticated.type !== 'authenticated') throw new Error('authentication failed');

    socket.send(
      JSON.stringify(
        frame('capabilities', {
          connectors: ['imessage'],
          rpc: ['source.status', 'search.query', 'search.cancel'],
          maximumResultCount: 100,
        }),
      ),
    );
    socket.send(
      JSON.stringify(
        frame('source.status', {
          sources: [
            {
              connector: 'imessage',
              readiness: 'ready',
              detail: 'ready',
              searchable: true,
              indexedCount: 42,
              checkpointAt: new Date().toISOString(),
              lastProbeAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    );
    socket.send(
      JSON.stringify(
        frame('heartbeat', {
          sessionId: authenticated.payload.sessionId,
          sequence: 1,
        }),
      ),
    );

    const list = await eventually(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v2/workspaces/${workspaceId}/devices`,
        headers: { authorization: 'Bearer e2e' },
      });
      const body = response.json<{ items: Array<{ state: string; sources: unknown[] }> }>();
      return body.items[0]?.state === 'online' && body.items[0].sources.length === 1
        ? body
        : undefined;
    });
    expect(list.items[0]).toMatchObject({
      deviceId,
      state: 'online',
      clientVersion: '2.0.0-e2e',
      connectors: ['imessage'],
    });

    const [target] = await runtime.router.listSearchTargets(
      workspaceId,
      new AbortController().signal,
    );
    expect(target?.availability).toBe('ready');
    if (!target) throw new Error('device target missing');
    const queryId = crypto.randomUUID();
    const outboundPromise = nextFrame(socket);
    const searchPromise = runtime.router.search(
      workspaceId,
      target,
      {
        version: 2,
        query: 'launch plan',
        connectors: ['imessage'],
        kinds: ['message'],
        limit: 20,
      } satisfies SearchRequest,
      { queryId, signal: new AbortController().signal },
    );
    const outbound = await outboundPromise;
    expect(outbound.type).toBe('search.request');
    if (outbound.type !== 'search.request') throw new Error('search request missing');
    socket.send(
      JSON.stringify(
        frame('search.response', {
          queryId: outbound.payload.queryId,
          items: [
            {
              ref: 'imessage:e2e-message',
              sourceId: 'e2e-message',
              revision: 'revision-1',
              connector: 'imessage',
              occurredAt: new Date().toISOString(),
              text: 'The production launch plan is ready.',
              participants: [],
              media: [],
              authoredByMe: true,
            },
          ],
          found: 1,
          nextCursor: null,
          tookMs: 1,
        }),
      ),
    );
    const result = await searchPromise;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceId: 'e2e-message',
      text: 'The production launch plan is ready.',
      origin: { placement: 'device', connector: 'imessage', deviceId },
    });

    const socketClosed = new Promise<void>((resolve) => socket?.once('close', () => resolve()));
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v2/workspaces/${workspaceId}/devices/${deviceId}`,
      headers: { authorization: 'Bearer e2e' },
    });
    expect(revoke.statusCode).toBe(204);
    await socketClosed;
    const durableState = await admin.query<{
      status: string;
      active_credentials: string;
    }>(
      `SELECT d.status,
        count(c.id) FILTER (WHERE c.revoked_at IS NULL)::text AS active_credentials
      FROM botmem.device_registry d
      LEFT JOIN botmem.device_session_credential c ON c.device_id = d.id
      WHERE d.id = $1::uuid
      GROUP BY d.status`,
      [deviceId],
    );
    expect(durableState.rows[0]).toEqual({ status: 'revoked', active_credentials: '0' });
  });
});

function frame<T extends DeviceFrame['type']>(
  type: T,
  payload: Extract<DeviceFrame, { type: T }>['payload'],
): Extract<DeviceFrame, { type: T }> {
  const now = Date.now();
  return DeviceFrameSchema.parse({
    protocol: DEVICE_PROTOCOL,
    requestId: crypto.randomUUID(),
    sentAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 10_000).toISOString(),
    type,
    payload,
  }) as Extract<DeviceFrame, { type: T }>;
}

function nextFrame(socket: WebSocket): Promise<DeviceFrame> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('WebSocket failed'));
    socket.once('error', onError);
    socket.once('message', (data: RawData) => {
      socket.off('error', onError);
      try {
        resolve(DeviceFrameSchema.parse(JSON.parse(rawText(data)) as unknown));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('eventual assertion timed out');
}
