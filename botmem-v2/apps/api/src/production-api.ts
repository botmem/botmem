import { FederatedSearchService } from '@botmem-v2/search-domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { composeHostedConnectionsApi } from './connections/composition.js';
import { composeDeviceRuntime } from './devices/composition.js';
import { CombinedSourceStatusReader } from './devices/source-status.js';
import type { RuntimeConfig } from './config.js';
import { PostgresRuntimeRoleValidator } from './projection-worker/postgres-role-health.js';
import {
  startRuntimeFromEnvironment,
  type RuntimeReadinessProbe,
  type RuntimeRegistrar,
  type RuntimeServices,
} from './runtime.js';
import type { WorkspaceAuthorizer } from './search-api.js';
import type { DeviceDeletionDeliveryPort } from './lifecycle/ports.js';
import { OpenAiEmbeddingProvider } from './search/openai-embedding.js';
import { PostgresHostedSearch } from './search/postgres-hosted-search.js';
import { NodePostgresPoolAdapter } from './search/node-postgres.js';
import { PostgresHostedSourceStatusReader } from './search/postgres-source-status.js';
import { RateLimitedSearchService } from './search/rate-limited-search.js';

const productionApiSchema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_EMBED_MODEL: z.string().trim().min(1).default('text-embedding-3-small'),
  OPENAI_EMBED_ENDPOINT: z.string().url().optional(),
  OPENAI_EMBED_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  HOSTED_SEARCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(450),
  HOSTED_SEARCH_HNSW_EF_SEARCH: z.coerce.number().int().min(40).max(1_000).default(600),
  HOSTED_SEARCH_DEADLINE_MS: z.coerce.number().int().min(100).max(30_000).default(750),
  DEVICE_SEARCH_DEADLINE_MS: z.coerce.number().int().min(100).max(30_000).default(1_000),
  SEARCH_RATE_LIMIT_WORKSPACE_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(60),
  SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(3_000),
});

export interface ProductionApiConfig {
  readonly openAiApiKey: string;
  readonly openAiEmbedModel: string;
  readonly openAiEmbedEndpoint?: string;
  readonly openAiEmbedTimeoutMs: number;
  readonly hostedStatementTimeoutMs: number;
  readonly hostedHnswEfSearch: number;
  readonly hostedDeadlineMs: number;
  readonly deviceDeadlineMs: number;
  readonly searchWorkspaceLimitPerMinute: number;
  readonly searchGlobalLimitPerMinute: number;
}

/** Optional bounded-context seam used by commerce and lifecycle modules. */
export interface ProductionApiExtension {
  readonly workspaceAuthorizerDecorator?: (authorizer: WorkspaceAuthorizer) => WorkspaceAuthorizer;
  readonly registrars?: readonly RuntimeRegistrar[];
  readonly readinessProbes?: readonly RuntimeReadinessProbe[];
  readonly close?: () => Promise<void>;
}

export type ProductionApiExtensionFactory = (input: {
  readonly apiPool: NodePostgresPoolAdapter;
  readonly config: RuntimeConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly deviceDeletionDelivery: DeviceDeletionDeliveryPort;
}) => ProductionApiExtension | Promise<ProductionApiExtension>;

export function parseProductionApiConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionApiConfig {
  const raw = productionApiSchema.parse(defined(environment));
  if (raw.HOSTED_SEARCH_STATEMENT_TIMEOUT_MS >= raw.HOSTED_SEARCH_DEADLINE_MS) {
    throw new ProductionApiConfigError(
      'HOSTED_SEARCH_STATEMENT_TIMEOUT_MS must be lower than HOSTED_SEARCH_DEADLINE_MS',
    );
  }
  if (raw.SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE < raw.SEARCH_RATE_LIMIT_WORKSPACE_PER_MINUTE) {
    throw new ProductionApiConfigError(
      'SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE must not be lower than the workspace limit',
    );
  }
  return Object.freeze({
    openAiApiKey: raw.OPENAI_API_KEY,
    openAiEmbedModel: raw.OPENAI_EMBED_MODEL,
    ...(raw.OPENAI_EMBED_ENDPOINT ? { openAiEmbedEndpoint: raw.OPENAI_EMBED_ENDPOINT } : {}),
    openAiEmbedTimeoutMs: raw.OPENAI_EMBED_TIMEOUT_MS,
    hostedStatementTimeoutMs: raw.HOSTED_SEARCH_STATEMENT_TIMEOUT_MS,
    hostedHnswEfSearch: raw.HOSTED_SEARCH_HNSW_EF_SEARCH,
    hostedDeadlineMs: raw.HOSTED_SEARCH_DEADLINE_MS,
    deviceDeadlineMs: raw.DEVICE_SEARCH_DEADLINE_MS,
    searchWorkspaceLimitPerMinute: raw.SEARCH_RATE_LIMIT_WORKSPACE_PER_MINUTE,
    searchGlobalLimitPerMinute: raw.SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE,
  });
}

/** Real API composition. It is deliberately incapable of receiving worker credentials. */
export async function composeProductionApiServices(
  apiPool: NodePostgresPoolAdapter,
  config: RuntimeConfig,
  environment: Readonly<Record<string, string | undefined>>,
  extensionFactories: readonly ProductionApiExtensionFactory[] = [],
): Promise<RuntimeServices> {
  const api = parseProductionApiConfig(environment);
  await new PostgresRuntimeRoleValidator(config.databaseConnectTimeoutMs).validate(
    apiPool,
    'botmem_api',
    AbortSignal.timeout(config.databaseConnectTimeoutMs),
  );
  const embeddings = new OpenAiEmbeddingProvider({
    apiKey: api.openAiApiKey,
    model: api.openAiEmbedModel,
    ...(api.openAiEmbedEndpoint ? { endpoint: api.openAiEmbedEndpoint } : {}),
    timeoutMs: api.openAiEmbedTimeoutMs,
  });
  const hostedStatuses = new PostgresHostedSourceStatusReader(apiPool);
  const connections = composeHostedConnectionsApi({
    apiPool,
    sourceStatuses: hostedStatuses,
    environment,
  });
  const deviceRuntime = await composeDeviceRuntime({ pool: apiPool, environment });
  try {
    const sourceStatuses = new CombinedSourceStatusReader(
      hostedStatuses,
      deviceRuntime.sourceStatuses,
    );
    const federatedSearch = new FederatedSearchService(
      new PostgresHostedSearch(apiPool, embeddings, {
        statementTimeoutMs: api.hostedStatementTimeoutMs,
        hnswEfSearch: api.hostedHnswEfSearch,
      }),
      deviceRuntime.router,
      deviceRuntime.router,
      { nowMs: () => Date.now() },
      { next: () => randomUUID() },
      {
        hostedDeadlineMs: api.hostedDeadlineMs,
        deviceDeadlineMs: api.deviceDeadlineMs,
        reciprocalRankConstant: 60,
      },
    );
    const search = new RateLimitedSearchService(
      federatedSearch,
      deviceRuntime.rateLimits,
      { nowMs: () => Date.now() },
      {
        workspaceLimit: api.searchWorkspaceLimitPerMinute,
        globalLimit: api.searchGlobalLimitPerMinute,
        windowMs: 60_000,
      },
    );
    const extensions = await Promise.all(
      extensionFactories.map((factory) =>
        factory({
          apiPool,
          config,
          environment,
          deviceDeletionDelivery: deviceRuntime.deletionDelivery,
        }),
      ),
    );
    const decorators = extensions
      .map((extension) => extension.workspaceAuthorizerDecorator)
      .filter((value): value is NonNullable<typeof value> => value !== undefined);
    return Object.freeze({
      search,
      sourceStatuses,
      connections: connections.service,
      oauthCallbacks: connections.service,
      connectionSuccessRedirectUrl: connections.successRedirectUrl,
      deviceRuntime,
      ...(decorators.length > 0
        ? {
            workspaceAuthorizerDecorator: (authorizer: WorkspaceAuthorizer) =>
              decorators.reduce((current, decorate) => decorate(current), authorizer),
          }
        : {}),
      registrars: Object.freeze(extensions.flatMap((extension) => extension.registrars ?? [])),
      readinessProbes: Object.freeze([
        { name: 'hosted_sync', isReady: () => connections.readiness.isReady() },
        { name: 'device_relay', isReady: () => deviceRuntime.isReady() },
        ...extensions.flatMap((extension) => extension.readinessProbes ?? []),
      ]),
      close: async () => {
        await Promise.all(extensions.map((extension) => extension.close?.() ?? Promise.resolve()));
      },
    });
  } catch (error) {
    await deviceRuntime.close().catch(() => undefined);
    throw error;
  }
}

export async function startProductionApiFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  extensionFactories: readonly ProductionApiExtensionFactory[] = [],
) {
  return startRuntimeFromEnvironment({ ...environment }, (pool, config) =>
    composeProductionApiServices(pool, config, environment, extensionFactories),
  );
}

export class ProductionApiConfigError extends Error {
  override readonly name = 'ProductionApiConfigError';
}

function defined(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
