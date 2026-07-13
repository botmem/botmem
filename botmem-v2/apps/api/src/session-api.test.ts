import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSessionApi } from './session-api.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';

describe('browser session API', () => {
  it('GET_whenOpaqueCookieIsValid_returnsOnlyPublicSessionAndNoStore', async () => {
    const app = Fastify({ logger: false });
    registerSessionApi(app, {
      read: async (cookieHeader) =>
        cookieHeader === '__Host-botmem_session=opaque'
          ? { version: 2, workspaceId: WORKSPACE_ID }
          : null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/session',
      headers: { cookie: '__Host-botmem_session=opaque' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ version: 2, workspaceId: WORKSPACE_ID });
    expect(response.body).not.toContain('token');
    await app.close();
  });

  it('GET_whenCookieIsMissing_returnsAuthenticationRequired', async () => {
    const app = Fastify({ logger: false });
    registerSessionApi(app, { read: async () => null });

    const response = await app.inject({ method: 'GET', url: '/v2/session' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'authentication_required' } });
    await app.close();
  });

  it('GET_whenReaderLeaksSecret_rejectsTheResponseContract', async () => {
    const app = Fastify({ logger: false });
    registerSessionApi(app, {
      read: async () =>
        ({
          version: 2,
          workspaceId: WORKSPACE_ID,
          accessToken: 'must-not-leak',
        }) as never,
    });

    const response = await app.inject({ method: 'GET', url: '/v2/session' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('must-not-leak');
    await app.close();
  });
});
