import { z } from 'zod';
import {
  FetchGmailBoundedHttpClient,
  GmailOAuthService,
  GoogleGmailAdapter,
} from '../connectors/gmail/index.js';
import {
  FetchOutlookBoundedHttpClient,
  MicrosoftGraphOutlookAdapter,
  OutlookOAuthService,
} from '../connectors/outlook/index.js';
import {
  NodeOwnTracksClock,
  NodeOwnTracksDns,
  NodeOwnTracksHash,
  NodePinnedHttpsTransport,
  OwnTracksEndpointPolicy,
  OwnTracksRecorderApi,
  SafeOwnTracksHttpClient,
} from '../connectors/owntracks/index.js';
import { NodeIngestionIdFactory, PostgresHostedIngestionUnitOfWork } from '../ingestion/index.js';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import {
  PostgresHostedSyncScheduler,
  PostgresHostedSyncWorkerJobStore,
} from './hosted-sync-job-store.js';
import { HostedSyncWorker, type HostedSyncTelemetryPort } from './hosted-sync-worker.js';
import { DeploymentKeyRing, NodeConnectorCrypto } from './key-ring.js';
import {
  GmailCredentialVaultAdapter,
  OutlookCredentialVaultAdapter,
  OwnTracksCredentialVaultAdapter,
  PostgresConnectorCredentialVault,
} from './postgres-credential-vault.js';
import { PostgresConnectionAccountRepository } from './postgres-connection-repository.js';
import { PostgresHostedSyncAccountConfigReader } from './postgres-hosted-sync-config.js';
import {
  PostgresConnectorOAuthStateStore,
  PostgresGmailOAuthStateRepository,
  PostgresOutlookOAuthStateRepository,
} from './postgres-oauth-state.js';
import type { ConnectionSourceStatusPort } from './ports.js';
import { HostedConnectionsService } from './service.js';

const providerCredentials = {
  CONNECTOR_VAULT_KEYS: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(4096),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().trim().min(1).max(4096),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096),
} as const;

const apiEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PUBLIC_BASE_URL: z.string().url(),
  PUBLIC_WEB_URL: z.string().url(),
  ...providerCredentials,
  OWNTRACKS_TEST_ALLOW_PRIVATE_ENDPOINTS: z.literal('1').optional(),
  OWNTRACKS_TEST_ENDPOINT_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  HOSTED_SYNC_READY_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(300).default(45),
});

const workerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  ...providerCredentials,
  OWNTRACKS_TEST_ALLOW_PRIVATE_ENDPOINTS: z.literal('1').optional(),
  OWNTRACKS_TEST_ENDPOINT_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  HOSTED_SYNC_WORKER_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  HOSTED_SYNC_MAX_RUN_SECONDS: z.coerce.number().int().min(30).max(3_300).default(900),
  HOSTED_SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  HOSTED_SYNC_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  HOSTED_SYNC_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
  HOSTED_SYNC_RETRY_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  HOSTED_SYNC_RETRY_MAX_MS: z.coerce.number().int().min(100).max(3_600_000).default(300_000),
  HOSTED_SYNC_EXHAUSTED_RETRY_SECONDS: z.coerce
    .number()
    .int()
    .min(900)
    .max(604_800)
    .default(21_600),
  HOSTED_SYNC_GMAIL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  HOSTED_SYNC_OUTLOOK_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  HOSTED_SYNC_OWNTRACKS_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
});

export interface HostedConnectionsApiCompositionDependencies {
  readonly apiPool: SqlPoolPort;
  readonly sourceStatuses: ConnectionSourceStatusPort;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface HostedConnectionsApiComposition {
  readonly service: HostedConnectionsService;
  readonly scheduler: PostgresHostedSyncScheduler;
  readonly readiness: PostgresHostedSyncScheduler;
  readonly successRedirectUrl: string;
  readonly oauthCallbackUrls: {
    readonly gmail: string;
    readonly outlook: string;
  };
  readonly providerAdapters: {
    readonly gmail: GoogleGmailAdapter;
    readonly outlook: MicrosoftGraphOutlookAdapter;
  };
}

export interface HostedSyncWorkerCompositionDependencies {
  readonly workerPool: SqlPoolPort;
  readonly telemetry: HostedSyncTelemetryPort;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface HostedSyncWorkerComposition {
  readonly jobs: PostgresHostedSyncWorkerJobStore;
  readonly worker: HostedSyncWorker;
  readonly providerAdapters: {
    readonly gmail: GoogleGmailAdapter;
    readonly outlook: MicrosoftGraphOutlookAdapter;
    readonly owntracks: OwnTracksRecorderApi;
  };
  readonly vaults: {
    readonly gmail: GmailCredentialVaultAdapter;
    readonly outlook: OutlookCredentialVaultAdapter;
    readonly owntracks: OwnTracksCredentialVaultAdapter;
  };
}

/** API-only composition. It never receives or retains a worker database pool. */
export function composeHostedConnectionsApi(
  dependencies: HostedConnectionsApiCompositionDependencies,
): HostedConnectionsApiComposition {
  const env = apiEnvironmentSchema.parse(defined(dependencies.environment));
  const publicBase = origin(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL');
  const publicWeb = origin(env.PUBLIC_WEB_URL, 'PUBLIC_WEB_URL');
  const keyRing = DeploymentKeyRing.parse(env.CONNECTOR_VAULT_KEYS);
  const crypto = new NodeConnectorCrypto(keyRing);
  const clock = { now: () => new Date().toISOString() };
  const scheduler = new PostgresHostedSyncScheduler(
    dependencies.apiPool,
    env.HOSTED_SYNC_READY_MAX_AGE_SECONDS,
    clock.now,
  );
  const stateStore = new PostgresConnectorOAuthStateStore(dependencies.apiPool);
  const vault = new PostgresConnectorCredentialVault(dependencies.apiPool, keyRing, 'botmem_api');
  const gmailVault = new GmailCredentialVaultAdapter(vault);
  const outlookVault = new OutlookCredentialVaultAdapter(vault);
  const adapters = providerAdapters(env, clock);
  const oauthCallbackUrls = Object.freeze({
    gmail: callbackUrl(publicBase, 'gmail'),
    outlook: callbackUrl(publicBase, 'outlook'),
  });

  const gmail = new GmailOAuthService(
    {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      redirectUri: oauthCallbackUrls.gmail,
    },
    new PostgresGmailOAuthStateRepository(stateStore),
    crypto,
    clock,
    adapters.gmail,
    adapters.gmail,
    gmailVault,
  );
  const outlook = new OutlookOAuthService(
    {
      clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
      redirectUri: oauthCallbackUrls.outlook,
    },
    new PostgresOutlookOAuthStateRepository(stateStore),
    crypto,
    clock,
    adapters.outlook,
    adapters.outlook,
    outlookVault,
  );
  const ownTracksEndpointPolicy = new OwnTracksEndpointPolicy(
    new NodeOwnTracksDns(),
    privateOwnTracksTestOptions(env),
  );
  const service = new HostedConnectionsService({
    accounts: new PostgresConnectionAccountRepository(dependencies.apiPool),
    vault,
    gmail,
    outlook,
    ownTracksEndpointPolicy,
    sourceStatuses: dependencies.sourceStatuses,
    scheduler,
    crypto,
  });

  return Object.freeze({
    service,
    scheduler,
    readiness: scheduler,
    successRedirectUrl: new URL('/connections', publicWeb).toString(),
    oauthCallbackUrls,
    providerAdapters: adapters,
  });
}

/** Worker-only composition. It cannot schedule API jobs or read API-owned OAuth state. */
export function composeHostedSyncWorker(
  dependencies: HostedSyncWorkerCompositionDependencies,
): HostedSyncWorkerComposition {
  const env = workerEnvironmentSchema.parse(defined(dependencies.environment));
  const keyRing = DeploymentKeyRing.parse(env.CONNECTOR_VAULT_KEYS);
  const crypto = new NodeConnectorCrypto(keyRing);
  const clock = { now: () => new Date().toISOString() };
  const adapters = providerAdapters(env, clock);
  const ownTracksClock = new NodeOwnTracksClock();
  const ownTracksHash = new NodeOwnTracksHash();
  const ownTracksPolicy = new OwnTracksEndpointPolicy(
    new NodeOwnTracksDns(),
    privateOwnTracksTestOptions(env),
  );
  const ownTracksAdapter = new OwnTracksRecorderApi(
    new SafeOwnTracksHttpClient(ownTracksPolicy, new NodePinnedHttpsTransport()),
    ownTracksClock,
  );
  const workerVault = new PostgresConnectorCredentialVault(
    dependencies.workerPool,
    keyRing,
    'botmem_worker',
  );
  const vaults = Object.freeze({
    gmail: new GmailCredentialVaultAdapter(workerVault),
    outlook: new OutlookCredentialVaultAdapter(workerVault),
    owntracks: new OwnTracksCredentialVaultAdapter(workerVault),
  });
  const jobs = new PostgresHostedSyncWorkerJobStore(
    dependencies.workerPool,
    {
      gmail: env.HOSTED_SYNC_GMAIL_INTERVAL_SECONDS * 1_000,
      outlook: env.HOSTED_SYNC_OUTLOOK_INTERVAL_SECONDS * 1_000,
      owntracks: env.HOSTED_SYNC_OWNTRACKS_INTERVAL_SECONDS * 1_000,
    },
    env.HOSTED_SYNC_EXHAUSTED_RETRY_SECONDS * 1_000,
  );
  const worker = new HostedSyncWorker({
    jobs,
    ingestionUnitOfWork: new PostgresHostedIngestionUnitOfWork(dependencies.workerPool),
    ids: new NodeIngestionIdFactory(),
    accountConfig: new PostgresHostedSyncAccountConfigReader(dependencies.workerPool),
    gmail: adapters.gmail,
    gmailVault: vaults.gmail,
    outlook: adapters.outlook,
    outlookVault: vaults.outlook,
    owntracks: ownTracksAdapter,
    ownTracksVault: vaults.owntracks,
    crypto,
    ownTracksHash,
    clock,
    telemetry: dependencies.telemetry,
    policy: {
      workerId: env.HOSTED_SYNC_WORKER_ID,
      maxRunMs: env.HOSTED_SYNC_MAX_RUN_SECONDS * 1_000,
      leaseMs: (env.HOSTED_SYNC_MAX_RUN_SECONDS + 30) * 1_000,
      maxAttempts: env.HOSTED_SYNC_MAX_ATTEMPTS,
      pollMs: env.HOSTED_SYNC_POLL_MS,
      heartbeatMs: env.HOSTED_SYNC_HEARTBEAT_SECONDS * 1_000,
      retryBaseMs: env.HOSTED_SYNC_RETRY_BASE_MS,
      retryMaxMs: env.HOSTED_SYNC_RETRY_MAX_MS,
    },
  });

  return Object.freeze({
    jobs,
    worker,
    providerAdapters: Object.freeze({
      ...adapters,
      owntracks: ownTracksAdapter,
    }),
    vaults,
  });
}

function providerAdapters(
  environment: {
    readonly GOOGLE_OAUTH_CLIENT_ID: string;
    readonly GOOGLE_OAUTH_CLIENT_SECRET: string;
    readonly MICROSOFT_OAUTH_CLIENT_ID: string;
    readonly MICROSOFT_OAUTH_CLIENT_SECRET: string;
  },
  clock: { readonly now: () => string },
): Readonly<{ gmail: GoogleGmailAdapter; outlook: MicrosoftGraphOutlookAdapter }> {
  return Object.freeze({
    gmail: new GoogleGmailAdapter(
      {
        clientId: environment.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: environment.GOOGLE_OAUTH_CLIENT_SECRET,
      },
      new FetchGmailBoundedHttpClient(),
      clock,
    ),
    outlook: new MicrosoftGraphOutlookAdapter(
      {
        clientId: environment.MICROSOFT_OAUTH_CLIENT_ID,
        clientSecret: environment.MICROSOFT_OAUTH_CLIENT_SECRET,
      },
      new FetchOutlookBoundedHttpClient(),
      clock,
    ),
  });
}

function callbackUrl(base: URL, connector: 'gmail' | 'outlook'): string {
  return new URL(`/v2/connections/oauth/${connector}/callback`, base).toString();
}

function origin(value: string, field: 'PUBLIC_BASE_URL' | 'PUBLIC_WEB_URL'): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.hostname !== 'localhost') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${field} must be a credential-free HTTPS origin`);
  }
  return url;
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function privateOwnTracksTestOptions(environment: {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly OWNTRACKS_TEST_ALLOW_PRIVATE_ENDPOINTS?: '1' | undefined;
  readonly OWNTRACKS_TEST_ENDPOINT_PORT?: number | undefined;
}): {
  readonly allowPrivateTestEndpoints?: true;
  readonly defaultAllowedPorts?: readonly number[];
} {
  // The production-composition canary deliberately parses production config,
  // but its deterministic OwnTracks recorder is loopback-only. Requiring both
  // Vitest's process marker and the explicit canary marker prevents these test
  // switches from changing a deployed production process.
  const verifiedProductionCanary =
    process.env['VITEST'] === 'true' && process.env['BOTMEM_V2_PRODUCTION_E2E'] === '1';
  return (environment.NODE_ENV === 'test' || verifiedProductionCanary) &&
    environment.OWNTRACKS_TEST_ALLOW_PRIVATE_ENDPOINTS === '1'
    ? {
        allowPrivateTestEndpoints: true,
        ...(environment.OWNTRACKS_TEST_ENDPOINT_PORT
          ? { defaultAllowedPorts: [environment.OWNTRACKS_TEST_ENDPOINT_PORT] }
          : {}),
      }
    : {};
}
