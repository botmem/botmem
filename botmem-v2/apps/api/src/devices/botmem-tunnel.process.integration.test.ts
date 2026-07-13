import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FederatedSearchService } from '@botmem-v2/search-domain';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSearchApi, WorkspaceAuthorizationError } from '../search-api.js';
import { NodePostgresPoolAdapter } from '../search/node-postgres.js';
import { authenticationMessage } from './authentication-service.js';
import { composeDeviceRuntime, type DeviceRuntimeComposition } from './composition.js';
import { DeviceRouteCancelledError, DeviceRouteRevokedError } from './device-router.js';

const enabled = process.env['BOTMEM_V2_DEVICE_PROCESS_CANARY'] === '1';
const DATABASE_URL = process.env['BOTMEM_V2_DEVICE_TEST_DATABASE_URL'] ?? '';
const REDIS_URL = process.env['BOTMEM_V2_DEVICE_TEST_REDIS_URL'] ?? '';
const TUNNEL_BINARY = resolve(
  process.env['BOTMEM_TUNNEL_TEST_BINARY'] ?? 'target/debug/botmem-tunnel',
);
const SEED_BINARY = resolve(
  process.env['BOTMEM_DEVICE_SEED_BINARY'] ?? 'target/debug/examples/seed_canary_index',
);
const LOCAL_SENTINEL = 'botmemlocalonlysentinel';
const INDEX_DOCUMENTS = 100_000;

describe.runIf(enabled)('real botmem-tunnel TLS process canary', () => {
  const workspaceId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const keyId = 'canary-ed25519-key';
  const namespace = `botmem:v2:process-canary:${crypto.randomUUID()}`;
  const runtimeLogs: string[] = [];
  const pool = new NodePostgresPoolAdapter({ connectionString: DATABASE_URL, max: 8 });
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  let root = '';
  let indexRoot = '';
  let caPem = '';
  let app: FastifyInstance;
  let runtime: DeviceRuntimeComposition;
  let signer: NetServer;
  let signingSocket = '';
  let signingRequests = 0;
  let helper: RunningHelper | undefined;
  let apiBaseUrl = '';
  let privateKey: CryptoKey;
  let publicKeyBase64Url = '';

  beforeAll(async () => {
    if (!DATABASE_URL || !REDIS_URL) {
      throw new Error('process canary requires PostgreSQL and Redis URLs');
    }
    root = await mkdtemp(join(tmpdir(), 'botmem-v2-canary-'));
    indexRoot = join(root, 'index');
    await generateTlsFixture(root);
    caPem = await readFile(join(root, 'ca.pem'), 'utf8');
    execFileSync(SEED_BINARY, [indexRoot, String(INDEX_DOCUMENTS)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
    });

    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    privateKey = keys.privateKey;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    publicKeyBase64Url = Buffer.from(publicKey).toString('base64url');
    signingSocket = `/tmp/botmem-canary-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`;
    signer = await startSigner(signingSocket, async (request) => {
      signingRequests += 1;
      expect(Object.keys(request).sort()).toEqual([
        'clientNonce',
        'deviceId',
        'keyId',
        'operation',
        'protocolVersion',
        'serverNonce',
      ]);
      expect(request).toMatchObject({
        protocolVersion: 'botmem.signing.ipc.v1',
        operation: 'signAuthentication',
        deviceId,
        keyId,
      });
      const signature = await crypto.subtle.sign(
        { name: 'Ed25519' },
        privateKey,
        authenticationMessage({
          deviceId,
          keyId,
          clientNonce: String(request['clientNonce']),
          serverNonce: String(request['serverNonce']),
        }),
      );
      return Buffer.from(signature).toString('base64url');
    });

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
        API_REPLICA_ID: 'process-canary-replica',
        DEVICE_REDIS_NAMESPACE: namespace,
        DEVICE_HEARTBEAT_INTERVAL_MS: '5000',
        DEVICE_CREDENTIAL_TTL_SECONDS: '300',
        DEVICE_RELAY_TIMEOUT_MS: '3000',
      },
    });
    app = Fastify({
      https: {
        key: await readFile(join(root, 'server.key')),
        cert: await readFile(join(root, 'server.pem')),
      },
      loggerInstance: captureLogger(runtimeLogs),
    });
    const authorize = async (
      requested: string,
      credentials: { readonly authorizationHeader?: string },
    ) => {
      if (credentials.authorizationHeader !== 'Bearer process-canary') {
        throw new WorkspaceAuthorizationError(
          401,
          'authentication_required',
          'Authentication required',
        );
      }
      return requested;
    };
    await runtime.register(app, { authorize });
    const federated = new FederatedSearchService(
      { search: async () => ({ candidates: [] }) },
      runtime.router,
      runtime.router,
      { nowMs: Date.now },
      { next: () => crypto.randomUUID() },
      {
        hostedDeadlineMs: 500,
        deviceDirectoryDeadlineMs: 500,
        deviceDeadlineMs: 3_000,
        reciprocalRankConstant: 60,
      },
    );
    registerSearchApi(app, { search: federated, workspaceAuthorizer: { authorize } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    apiBaseUrl = `https://localhost:${address.port}/`;
  }, 120_000);

  afterAll(async () => {
    if (helper?.child.exitCode === null) {
      helper.child.kill('SIGTERM');
      await helper.exit.catch(() => undefined);
    }
    if (signer) {
      await new Promise<void>((resolveClose) => signer.close(() => resolveClose()));
    }
    await unlink(signingSocket).catch(() => undefined);
    await app?.close();
    await runtime?.close();
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `${namespace}:*`, COUNT: 100 })) {
      keys.push(...redisKeys(batch));
    }
    if (keys.length > 0) await redis.del(keys);
    await redis.quit();
    await pool.close();
    await admin.end();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('rejects insecure TLS, pairs publicly, searches locally, cancels, terminates, and revokes', async () => {
    const baseConfig = tunnelConfig(apiBaseUrl, caPem);
    for (const insecure of ['http://localhost:1/', 'ws://localhost:1/']) {
      const result = await runHelperToExit({ ...baseConfig, apiBaseUrl: insecure });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe('botmem-tunnel:configuration_rejected\n');
    }
    const expiredCode = await issuePairingCode();
    await admin.query(
      `UPDATE botmem.device_pairing_grant
          SET created_at = statement_timestamp() - interval '10 minutes',
              expires_at = statement_timestamp() - interval '5 minutes'
        WHERE tenant_id = $1::uuid AND workspace_id = $1::uuid
          AND consumed_at IS NULL`,
      [workspaceId],
    );
    expect((await redeem(expiredCode, crypto.randomUUID())).statusCode).toBe(401);

    const pairingCode = await issuePairingCode();
    const paired = await redeem(pairingCode, deviceId);
    expect(paired.statusCode).toBe(201);
    expect(paired.headers['cache-control']).toBe('no-store');
    expect(paired.json()).toEqual({ deviceId, state: 'paired' });
    expect((await redeem(pairingCode, crypto.randomUUID())).statusCode).toBe(401);

    // The device now exists, so either connection would reach the private
    // signer if certificate or hostname verification were disabled.
    const signerCountBeforeTlsFailures = signingRequests;
    const untrusted = await runHelperToExit({ ...baseConfig, trustAnchorPem: undefined });
    expect(untrusted.code).toBe(1);
    expect(untrusted.stderr).toBe('botmem-tunnel:connection_failed\n');
    const port = new URL(apiBaseUrl).port;
    const wrongHost = await runHelperToExit({
      ...baseConfig,
      apiBaseUrl: `https://127.0.0.1:${port}/`,
    });
    expect(wrongHost.code).toBe(1);
    expect(wrongHost.stderr).toBe('botmem-tunnel:connection_failed\n');
    expect(signingRequests).toBe(signerCountBeforeTlsFailures);

    helper = spawnHelper(baseConfig);
    await waitUntilOnline();
    expect(signingRequests).toBe(signerCountBeforeTlsFailures + 1);

    const first = await httpSearch(LOCAL_SENTINEL);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      items: Array<{ text: string; origin: { placement: string; connector: string } }>;
      coverage: { lanes: Array<{ status: string }> };
      found: number;
    }>();
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.items[0]).toMatchObject({
      text: expect.stringContaining(LOCAL_SENTINEL),
      origin: { placement: 'device', connector: 'imessage' },
    });
    expect(firstBody.coverage.lanes[0]?.status).toBe('complete');
    expect(firstBody.found).toBe(20);

    const samples: number[] = [];
    const localLaneSamples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const response = await httpSearch(index % 2 === 0 ? LOCAL_SENTINEL : 'ordinary device');
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        coverage: { lanes: Array<{ status: string; tookMs: number }> };
      }>();
      expect(body.coverage.lanes[0]?.status).toBe('complete');
      localLaneSamples.push(body.coverage.lanes[0]?.tookMs ?? Number.POSITIVE_INFINITY);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    localLaneSamples.sort((left, right) => left - right);
    const localP95Ms = localLaneSamples[94] ?? Number.POSITIVE_INFINITY;
    const p95Ms = samples[94] ?? Number.POSITIVE_INFINITY;
    const p99Ms = samples[98] ?? Number.POSITIVE_INFINITY;
    console.info(
      `botmem process canary 100-query latency local-p95=${localP95Ms.toFixed(1)}ms ` +
        `federated-p95=${p95Ms.toFixed(1)}ms federated-p99=${p99Ms.toFixed(1)}ms`,
    );
    expect(localP95Ms).toBeLessThanOrEqual(750);
    expect(p95Ms).toBeLessThanOrEqual(1_500);
    expect(p99Ms).toBeLessThanOrEqual(3_000);

    const [target] = await runtime.router.listSearchTargets(
      workspaceId,
      new AbortController().signal,
    );
    if (!target) throw new Error('ready device target missing');
    const cancelled = new AbortController();
    const pending = runtime.router.search(
      workspaceId,
      target,
      { version: 2, query: 'ordinary device', connectors: ['imessage'], limit: 20 },
      { queryId: crypto.randomUUID(), signal: cancelled.signal },
    );
    setTimeout(() => cancelled.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(DeviceRouteCancelledError);
    expect((await httpSearch(LOCAL_SENTINEL)).statusCode).toBe(200);

    await assertRemoteStoresExclude(LOCAL_SENTINEL);
    expect(runtimeLogs.join('\n')).not.toContain(LOCAL_SENTINEL);
    expect(helper.stderr()).not.toContain(LOCAL_SENTINEL);

    const firstExit = helper.exit;
    helper.child.kill('SIGTERM');
    expect(await firstExit).toMatchObject({ code: 0, signal: null });
    await waitUntilOffline();

    helper = spawnHelper(baseConfig);
    await waitUntilOnline();
    const revokedExit = helper.exit;
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v2/workspaces/${workspaceId}/devices/${deviceId}`,
      headers: { authorization: 'Bearer process-canary' },
    });
    expect(revoke.statusCode).toBe(204);
    expect(await revokedExit).toMatchObject({ code: 20, signal: null });
    await expect(
      runtime.router.search(
        workspaceId,
        target,
        { version: 2, query: LOCAL_SENTINEL, connectors: ['imessage'], limit: 20 },
        { queryId: crypto.randomUUID(), signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(DeviceRouteRevokedError);
    const afterRevoke = await httpSearch(LOCAL_SENTINEL);
    expect(afterRevoke.statusCode).toBe(200);
    expect(afterRevoke.json<{ items: unknown[] }>().items).toEqual([]);
    await assertRemoteStoresExclude(LOCAL_SENTINEL);
    expect(runtimeLogs.join('\n')).not.toContain(LOCAL_SENTINEL);
    expect(helper.stderr()).not.toContain(LOCAL_SENTINEL);
  }, 120_000);

  function tunnelConfig(baseUrl: string, trustAnchorPem: string | undefined) {
    return {
      protocolVersion: 'botmem.tunnel.config.v1',
      apiBaseUrl: baseUrl,
      workspaceId,
      deviceId,
      keyId,
      clientVersion: 'botmem-tunnel/process-canary',
      connectors: ['imessage'],
      indexRoot,
      signingSocket,
      ...(trustAnchorPem ? { trustAnchorPem } : {}),
    };
  }

  async function issuePairingCode(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/devices/pairing-codes`,
      headers: { authorization: 'Bearer process-canary' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    return response.json<{ code: string }>().code;
  }

  function redeem(code: string, pairedDeviceId: string) {
    return app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/devices/pair`,
      payload: {
        code,
        deviceId: pairedDeviceId,
        displayName: 'Process Canary Mac',
        keyId,
        publicKeyBase64Url,
        connectors: ['imessage'],
      },
    });
  }

  function httpSearch(query: string) {
    return app.inject({
      method: 'POST',
      url: `/v2/workspaces/${workspaceId}/search`,
      headers: { authorization: 'Bearer process-canary' },
      payload: { version: 2, query, connectors: ['imessage'], kinds: ['message'], limit: 20 },
    });
  }

  async function waitUntilOnline(): Promise<void> {
    await eventually(async () => {
      if (helper?.child.exitCode !== null) {
        throw new Error(
          `helper exited ${helper?.child.exitCode}: ${helper?.stderr()} logs=${runtimeLogs.join('|')}`,
        );
      }
      const response = await app.inject({
        method: 'GET',
        url: `/v2/workspaces/${workspaceId}/devices`,
        headers: { authorization: 'Bearer process-canary' },
      });
      const item = response.json<{
        items: Array<{ state: string; sources: Array<{ readiness: string; searchable: boolean }> }>;
      }>().items[0];
      return (
        item?.state === 'online' &&
        item.sources[0]?.readiness === 'ready' &&
        item.sources[0]?.searchable === true
      );
    }, 10_000);
  }

  async function waitUntilOffline(): Promise<void> {
    await eventually(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v2/workspaces/${workspaceId}/devices`,
        headers: { authorization: 'Bearer process-canary' },
      });
      return response.json<{ items: Array<{ state: string }> }>().items[0]?.state === 'offline';
    }, 10_000);
  }

  async function assertRemoteStoresExclude(sentinel: string): Promise<void> {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'botmem' AND table_type = 'BASE TABLE'`,
    );
    for (const { table_name: table } of tables.rows) {
      if (!/^[a-z0-9_]+$/u.test(table)) throw new Error('unsafe table name');
      const result = await admin.query<{ matches: string }>(
        `SELECT count(*)::text AS matches FROM botmem.${table} row
          WHERE to_jsonb(row)::text LIKE $1`,
        [`%${sentinel}%`],
      );
      expect(result.rows[0]?.matches, `PostgreSQL table botmem.${table}`).toBe('0');
    }
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    try {
      for await (const batch of redis.scanIterator({ MATCH: `${namespace}:*`, COUNT: 100 })) {
        for (const key of redisKeys(batch)) {
          const type = await redis.type(key);
          const values =
            type === 'string'
              ? [await redis.get(key)]
              : type === 'zset'
                ? await redis.zRange(key, 0, -1)
                : type === 'set'
                  ? await redis.sMembers(key)
                  : type === 'list'
                    ? await redis.lRange(key, 0, -1)
                    : type === 'hash'
                      ? Object.entries(await redis.hGetAll(key)).flat()
                      : [];
          expect(JSON.stringify(values), `Redis key ${key}`).not.toContain(sentinel);
        }
      }
    } finally {
      await redis.quit();
    }
  }

  function spawnHelper(config: object): RunningHelper {
    const child = spawn(TUNNEL_BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString('utf8');
    });
    const exit = new Promise<ProcessExit>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    child.stdin.end(JSON.stringify(config));
    return { child, exit, stderr: () => stderr };
  }

  async function runHelperToExit(config: object): Promise<ProcessExit & { stderr: string }> {
    const running = spawnHelper(config);
    const result = await Promise.race([
      running.exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('helper did not exit')), 8_000),
      ),
    ]).finally(() => {
      if (running.child.exitCode === null) running.child.kill('SIGKILL');
    });
    return { ...result, stderr: running.stderr() };
  }
});

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningHelper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly stderr: () => string;
}

async function generateTlsFixture(root: string): Promise<void> {
  const quiet = { stdio: ['ignore', 'ignore', 'ignore'] as const };
  const extensionFile = join(root, 'server.ext');
  await writeFile(
    extensionFile,
    'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-subj',
      '/CN=Botmem Process Canary CA',
      '-keyout',
      join(root, 'ca.key'),
      '-out',
      join(root, 'ca.pem'),
    ],
    quiet,
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(root, 'server.key'),
      '-out',
      join(root, 'server.csr'),
    ],
    quiet,
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-sha256',
      '-days',
      '2',
      '-in',
      join(root, 'server.csr'),
      '-CA',
      join(root, 'ca.pem'),
      '-CAkey',
      join(root, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(root, 'server.pem'),
      '-extfile',
      extensionFile,
    ],
    quiet,
  );
}

async function startSigner(
  path: string,
  sign: (request: Record<string, unknown>) => Promise<string>,
): Promise<NetServer> {
  await unlink(path).catch(() => undefined);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let received = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > 16_384) {
        handled = true;
        socket.destroy();
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(received.subarray(0, newline).toString('utf8')) as Record<
            string,
            unknown
          >;
          const signature = await sign(request);
          socket.end(
            `${JSON.stringify({
              protocolVersion: 'botmem.signing.ipc.v1',
              ok: true,
              signatureBase64Url: signature,
              errorCode: null,
            })}\n`,
          );
        } catch {
          socket.end(
            `${JSON.stringify({
              protocolVersion: 'botmem.signing.ipc.v1',
              ok: false,
              signatureBase64Url: null,
              errorCode: 'signing_rejected',
            })}\n`,
          );
        }
      })();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  await chmod(path, 0o600);
  return server;
}

function captureLogger(lines: string[]): FastifyBaseLogger {
  const write = (...values: unknown[]) => {
    lines.push(
      values
        .map((value) => {
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            return String(value);
          }
          if (
            value &&
            typeof value === 'object' &&
            'code' in value &&
            typeof value.code === 'string'
          ) {
            return `code=${value.code}`;
          }
          return '[structured]';
        })
        .join(' '),
    );
  };
  const logger = {
    level: 'trace',
    fatal: write,
    error: write,
    warn: write,
    info: write,
    debug: write,
    trace: write,
    silent: write,
    child: () => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

async function eventually(operation: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('eventual assertion timed out');
}

function redisKeys(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}
