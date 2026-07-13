import { describe, expect, it, vi } from 'vitest';
import type { SqlPoolPort } from '../search/postgres-ports.js';
import { composeHostedConnectionsApi, composeHostedSyncWorker } from './index.js';

const apiPool = { connect: vi.fn() } as unknown as SqlPoolPort;
const workerPool = { connect: vi.fn() } as unknown as SqlPoolPort;
const providerEnvironment = {
  CONNECTOR_VAULT_KEYS: `1:${Buffer.alloc(32, 7).toString('base64url')}`,
  GOOGLE_OAUTH_CLIENT_ID: 'google-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  MICROSOFT_OAUTH_CLIENT_ID: 'microsoft-client',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'microsoft-secret',
};

describe('hosted connection production composition', () => {
  it('missingProviderOrDeploymentKeyConfiguration_failsBeforeDatabaseUse', () => {
    expect(() =>
      composeHostedConnectionsApi({
        apiPool,
        sourceStatuses: { list: vi.fn() },
        environment: {
          PUBLIC_BASE_URL: 'https://api.botmem.test',
          PUBLIC_WEB_URL: 'https://app.botmem.test',
        },
      }),
    ).toThrow();
    expect(() =>
      composeHostedSyncWorker({
        workerPool,
        telemetry: { record: vi.fn() },
        environment: { HOSTED_SYNC_WORKER_ID: 'worker.test' },
      }),
    ).toThrow();
    expect(apiPool.connect).not.toHaveBeenCalled();
    expect(workerPool.connect).not.toHaveBeenCalled();
  });

  it('apiComposition_usesApiCallbacksAndWebSuccessRedirectWithoutWorkerConfiguration', () => {
    const composition = composeHostedConnectionsApi({
      apiPool,
      sourceStatuses: { list: vi.fn() },
      environment: {
        ...providerEnvironment,
        PUBLIC_BASE_URL: 'https://api.botmem.test',
        PUBLIC_WEB_URL: 'https://app.botmem.test',
      },
    });

    expect(composition.oauthCallbackUrls).toEqual({
      gmail: 'https://api.botmem.test/v2/connections/oauth/gmail/callback',
      outlook: 'https://api.botmem.test/v2/connections/oauth/outlook/callback',
    });
    expect(composition.successRedirectUrl).toBe('https://app.botmem.test/connections');
    expect(composition.scheduler).toBe(composition.readiness);
    expect(composition.service).toBeDefined();
    expect(apiPool.connect).not.toHaveBeenCalled();
    expect(workerPool.connect).not.toHaveBeenCalled();
  });

  it('workerComposition_requiresOnlyWorkerConfigurationAndHasNoApiScheduler', () => {
    const composition = composeHostedSyncWorker({
      workerPool,
      telemetry: { record: vi.fn() },
      environment: {
        ...providerEnvironment,
        HOSTED_SYNC_WORKER_ID: 'worker.test',
      },
    });

    expect(composition.worker).toBeDefined();
    expect(composition.jobs).toBeDefined();
    expect(composition).not.toHaveProperty('scheduler');
    expect(composition).not.toHaveProperty('readiness');
    expect(composition.vaults).toEqual(
      expect.objectContaining({
        gmail: expect.any(Object),
        outlook: expect.any(Object),
        owntracks: expect.any(Object),
      }),
    );
    expect(apiPool.connect).not.toHaveBeenCalled();
    expect(workerPool.connect).not.toHaveBeenCalled();
  });
});
