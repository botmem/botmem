import { SourceStatusSchema } from '@botmem-v2/contracts';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSourceStatusApi } from './source-status-api.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';

describe('registerSourceStatusApi', () => {
  it('GET sources_withHttpOnlySession_authorizesAndReturnsCanonicalStatuses', async () => {
    const app = Fastify({ logger: false });
    const authorize = vi.fn(async () => WORKSPACE_ID);
    const list = vi.fn(async () => [
      SourceStatusSchema.parse({
        connector: 'gmail',
        readiness: 'ready',
        searchable: true,
        indexedCount: 1,
        checkpointAt: '2026-07-13T10:00:00Z',
        lastProbeAt: '2026-07-13T10:01:00Z',
      }),
    ]);
    registerSourceStatusApi(app, {
      sourceStatuses: { list },
      workspaceAuthorizer: { authorize },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${WORKSPACE_ID}/sources`,
      headers: { cookie: 'botmem_session=opaque' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ connector: 'gmail', readiness: 'ready' }]);
    expect(authorize).toHaveBeenCalledWith(WORKSPACE_ID, {
      cookieHeader: 'botmem_session=opaque',
    });
    expect(list).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(AbortSignal));
    await app.close();
  });
});
