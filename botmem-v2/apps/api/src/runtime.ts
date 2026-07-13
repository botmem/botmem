import type {
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from '@botmem-v2/sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseRuntimeConfig, type RuntimeConfig } from './config.js';
import { registerHostedConnectionsApi, type OAuthCallbackPort } from './connections/index.js';
import {
  NodeTokenSecurity,
  EmailLoginService,
  OpaqueCredentialService,
  PostgresCredentialRepository,
  ResendLoginDelivery,
  registerBrowserCsrfProtection,
  registerCredentialApi,
  registerEmailLoginApi,
  type CredentialRepositoryPort,
  type LoginChallengeRepositoryPort,
  type LoginDeliveryPort,
  UnavailableLoginDelivery,
} from './identity/index.js';
import { registerMcpApi } from './mcp-api.js';
import { registerSearchApi, type WorkspaceAuthorizer } from './search-api.js';
import { NodePostgresPoolAdapter } from './search/node-postgres.js';
import type { SourceStatusReaderPort } from './search/postgres-source-status.js';
import type { SqlClientPort, SqlPoolPort } from './search/postgres-ports.js';
import { registerSourceStatusApi } from './search/source-status-api.js';
import { registerSessionApi } from './session-api.js';
import { registerPublicReleaseApi } from './public-release-api.js';

export interface RuntimeServices {
  readonly search: SearchApplicationService;
  readonly sourceStatuses: SourceStatusReaderPort;
  readonly connections: ConnectionsApplicationService;
  readonly oauthCallbacks: OAuthCallbackPort;
  readonly connectionSuccessRedirectUrl: string;
  readonly deviceRuntime: RuntimeDeviceServices;
  readonly loginDelivery?: LoginDeliveryPort;
  readonly workspaceAuthorizerDecorator?: (authorizer: WorkspaceAuthorizer) => WorkspaceAuthorizer;
  readonly registrars?: readonly RuntimeRegistrar[];
  readonly readinessProbes?: readonly RuntimeReadinessProbe[];
  readonly close?: () => Promise<void>;
}

export interface RuntimeRegistrar {
  register(
    app: FastifyInstance,
    authorizer: WorkspaceAuthorizer,
    credentials: OpaqueCredentialService,
  ): Promise<void> | void;
}

export interface RuntimeReadinessProbe {
  /** Stable, non-secret reason-code prefix suitable for readiness responses. */
  readonly name: string;
  isReady(): Promise<boolean>;
}

export interface RuntimeDeviceServices {
  readonly devices: DevicesApplicationService;
  readonly register: (
    app: FastifyInstance,
    workspaceAuthorizer: WorkspaceAuthorizer,
    readAuthorizer?: WorkspaceAuthorizer,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RuntimeDependencies extends RuntimeServices {
  readonly sqlPool: SqlPoolPort & { close?(): Promise<void> };
  readonly credentialRepository?: CredentialRepositoryPort;
  readonly loginChallenges?: LoginChallengeRepositoryPort;
  readonly clock?: { nowMs(): number };
}

export type RuntimeServiceFactory = (
  pool: NodePostgresPoolAdapter,
  config: RuntimeConfig,
) => RuntimeServices | Promise<RuntimeServices>;

/** One composition root for browser, CLI, MCP, source status, and search. */
export function buildRuntimeApp(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1_048_576,
    // Production ingress is Caddy on a private Docker network. Trust only
    // local/private proxy hops so request.ip is the real client for abuse caps.
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
    logger:
      config.environment === 'test'
        ? false
        : {
            level: 'info',
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
            serializers: {
              req(request) {
                return {
                  method: request.method,
                  path: requestPathForLog(request.url),
                };
              },
            },
          },
  });
  const postgresIdentity = new PostgresCredentialRepository(dependencies.sqlPool);
  const repository = dependencies.credentialRepository ?? postgresIdentity;
  const credentials = new OpaqueCredentialService(
    repository,
    new NodeTokenSecurity(config.tokenPepper),
    dependencies.clock ?? { nowMs: () => Date.now() },
    {
      cookieName: config.sessionCookieName,
      sessionTtlMs: config.sessionTtlMs,
      patMaxTtlMs: config.patMaxTtlMs,
    },
  );
  const emailLogin = new EmailLoginService(
    dependencies.loginChallenges ?? postgresIdentity,
    dependencies.loginDelivery ??
      (config.resendLogin
        ? new ResendLoginDelivery(config.resendLogin)
        : new UnavailableLoginDelivery()),
    credentials,
    new NodeTokenSecurity(config.tokenPepper),
    dependencies.clock ?? { nowMs: () => Date.now() },
    { publicWebBaseUrl: config.publicWebBaseUrl },
  );
  const browserAuthorizer = dependencies.workspaceAuthorizerDecorator
    ? dependencies.workspaceAuthorizerDecorator(credentials)
    : credentials;
  const searchCredentialAuthorizer = credentials.readOnlySearchAuthorizer();
  const searchAuthorizer = dependencies.workspaceAuthorizerDecorator
    ? dependencies.workspaceAuthorizerDecorator(searchCredentialAuthorizer)
    : searchCredentialAuthorizer;
  const connectionReadCredentialAuthorizer =
    credentials.readOnlyScopeAuthorizer('botmem:connections:read');
  const connectionReadAuthorizer = dependencies.workspaceAuthorizerDecorator
    ? dependencies.workspaceAuthorizerDecorator(connectionReadCredentialAuthorizer)
    : connectionReadCredentialAuthorizer;
  const deviceReadCredentialAuthorizer = credentials.readOnlyScopeAuthorizer('botmem:devices:read');
  const deviceReadAuthorizer = dependencies.workspaceAuthorizerDecorator
    ? dependencies.workspaceAuthorizerDecorator(deviceReadCredentialAuthorizer)
    : deviceReadCredentialAuthorizer;

  registerBrowserCsrfProtection(app, {
    cookieName: config.sessionCookieName,
    allowedOrigins: config.trustedOrigins,
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (_request.raw.url?.startsWith('/v2/')) {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    }
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secureCookies) {
      reply.header('strict-transport-security', 'max-age=31536000');
    }
    return payload;
  });

  registerSessionApi(app, { read: (cookie) => credentials.readBrowserSession(cookie) });
  registerPublicReleaseApi(app, config.publicReleases);
  registerCredentialApi(app, credentials, {
    cookieName: config.sessionCookieName,
    secureCookies: config.secureCookies,
  });
  registerEmailLoginApi(app, emailLogin, {
    cookieName: config.sessionCookieName,
    secureCookies: config.secureCookies,
    allowedOrigins: config.trustedOrigins,
  });
  registerSearchApi(app, {
    search: dependencies.search,
    workspaceAuthorizer: searchAuthorizer,
  });
  registerHostedConnectionsApi(app, {
    connections: dependencies.connections,
    oauthCallbacks: dependencies.oauthCallbacks,
    workspaceAuthorizer: browserAuthorizer,
    readAuthorizer: connectionReadAuthorizer,
    successRedirectUrl: dependencies.connectionSuccessRedirectUrl,
  });
  app.register(async (deviceApp) => {
    await dependencies.deviceRuntime.register(deviceApp, browserAuthorizer, deviceReadAuthorizer);
  });
  registerSourceStatusApi(app, {
    sourceStatuses: dependencies.sourceStatuses,
    workspaceAuthorizer: browserAuthorizer,
  });
  registerMcpApi(app, {
    search: dependencies.search,
    connections: dependencies.connections,
    devices: dependencies.deviceRuntime.devices,
    workspaceAuthorizer: searchAuthorizer,
    connectionReadAuthorizer,
    deviceReadAuthorizer,
    publicBaseUrl: config.publicBaseUrl,
    allowedOrigins: config.trustedOrigins,
  });
  for (const registrar of dependencies.registrars ?? []) {
    app.register(async (registrarApp) => {
      await registrar.register(registrarApp, credentials, credentials);
    });
  }

  app.get('/health/live', async (_request, reply) => reply.code(200).send({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    let client: SqlClientPort | undefined;
    try {
      client = await dependencies.sqlPool.connect();
      await client.query({ text: 'BEGIN' });
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      await client.query({ text: 'SELECT 1' });
      await client.query({ text: 'ROLLBACK' });
      if (!(await emailLogin.readiness().catch(() => false))) {
        return reply.code(503).send({
          status: 'not_ready',
          reason: 'login_delivery_unconfigured',
        });
      }
      for (const probe of dependencies.readinessProbes ?? []) {
        if (!(await probe.isReady().catch(() => false))) {
          return reply.code(503).send({
            status: 'not_ready',
            reason: `${readinessName(probe.name)}_unavailable`,
          });
        }
      }
      return reply.code(200).send({ status: 'ready' });
    } catch {
      await client?.query({ text: 'ROLLBACK' }).catch(() => undefined);
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    } finally {
      client?.release();
    }
  });
  app.addHook('onClose', async () => {
    await Promise.all([
      dependencies.close?.() ?? Promise.resolve(),
      dependencies.deviceRuntime.close(),
      dependencies.sqlPool.close?.() ?? Promise.resolve(),
    ]);
  });
  return app;
}

function readinessName(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : 'component';
}

/** OAuth codes/state and any future query credentials must never reach logs. */
export function requestPathForLog(url: string): string {
  const path = url.split('?', 1)[0] ?? '/';
  return path.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, ':id');
}

/** Parses environment first, creates the real PostgreSQL boundary, then starts Fastify. */
export async function startRuntimeFromEnvironment(
  environment: Record<string, string | undefined>,
  serviceFactory: RuntimeServiceFactory,
): Promise<FastifyInstance> {
  const config = parseRuntimeConfig(environment);
  const pool = new NodePostgresPoolAdapter({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    application_name: 'botmem-v2-api',
  });
  try {
    const services = await serviceFactory(pool, config);
    const app = buildRuntimeApp(config, { ...services, sqlPool: pool });
    await app.listen({ host: config.host, port: config.port });
    return app;
  } catch (error) {
    await pool.close();
    throw error;
  }
}
