import { describe, expect, it } from 'vitest';
import { parseProductionApiConfig, ProductionApiConfigError } from './production-api.js';

describe('production API composition configuration', () => {
  it('normalizes bounded hosted and device search settings', () => {
    expect(
      parseProductionApiConfig({
        OPENAI_API_KEY: `sk-${'a'.repeat(32)}`,
        OPENAI_EMBED_MODEL: 'text-embedding-3-small',
        HOSTED_SEARCH_STATEMENT_TIMEOUT_MS: '400',
        HOSTED_SEARCH_HNSW_EF_SEARCH: '700',
        HOSTED_SEARCH_DEADLINE_MS: '700',
        DEVICE_SEARCH_DEADLINE_MS: '900',
      }),
    ).toMatchObject({
      openAiEmbedModel: 'text-embedding-3-small',
      hostedStatementTimeoutMs: 400,
      hostedHnswEfSearch: 700,
      hostedDeadlineMs: 700,
      deviceDeadlineMs: 900,
      searchWorkspaceLimitPerMinute: 60,
      searchGlobalLimitPerMinute: 3_000,
    });
  });

  it('rejects a global search ceiling lower than one workspace ceiling', () => {
    expect(() =>
      parseProductionApiConfig({
        OPENAI_API_KEY: `sk-${'a'.repeat(32)}`,
        SEARCH_RATE_LIMIT_WORKSPACE_PER_MINUTE: '100',
        SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE: '99',
      }),
    ).toThrow(ProductionApiConfigError);
  });

  it('fails closed when the database statement can outlive its lane', () => {
    expect(() =>
      parseProductionApiConfig({
        OPENAI_API_KEY: `sk-${'a'.repeat(32)}`,
        HOSTED_SEARCH_STATEMENT_TIMEOUT_MS: '800',
        HOSTED_SEARCH_DEADLINE_MS: '700',
      }),
    ).toThrow(ProductionApiConfigError);
  });

  it('never requires a worker database secret in the API configuration', () => {
    expect(
      parseProductionApiConfig({
        OPENAI_API_KEY: `sk-${'a'.repeat(32)}`,
      }).openAiEmbedModel,
    ).toBe('text-embedding-3-small');
  });
});
