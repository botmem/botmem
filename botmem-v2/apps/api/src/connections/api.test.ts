import type { ConnectionsApplicationService } from '@botmem-v2/sdk';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAuthorizationError } from '../search-api.js';
import { registerHostedConnectionsApi, type OAuthCallbackPort } from './index.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const CONNECTION_ID = '20000000-0000-4000-8000-000000000001';
const CONNECTION = {
  id: CONNECTION_ID,
  connector: 'owntracks' as const,
  authType: 'basic' as const,
  label: 'OwnTracks · recorder.example.test',
  state: 'syncing' as const,
  source: {
    connector: 'owntracks' as const,
    readiness: 'connected' as const,
    searchable: false,
    reasonCode: 'first_checkpoint_pending',
  },
};

function build(options: { authorized?: boolean } = {}) {
  const connections: ConnectionsApplicationService = {
    listConnections: vi.fn().mockResolvedValue({ version: 2, items: [] }),
    beginOAuthConnection: vi.fn().mockResolvedValue({
      version: 2,
      connector: 'gmail',
      accountId: CONNECTION_ID,
      authorizationUrl: 'https://accounts.google.test/authorize',
      expiresAt: '2026-07-13T10:10:00.000Z',
    }),
    connectOwnTracks: vi.fn().mockResolvedValue({ version: 2, connection: CONNECTION }),
    actOnConnection: vi.fn().mockResolvedValue({ version: 2, connection: CONNECTION }),
  };
  const callbacks: OAuthCallbackPort = {
    completeGmail: vi.fn().mockResolvedValue({ version: 2, connection: CONNECTION }),
    completeOutlook: vi.fn().mockResolvedValue({ version: 2, connection: CONNECTION }),
  };
  const app = Fastify({ logger: false });
  registerHostedConnectionsApi(app, {
    connections,
    oauthCallbacks: callbacks,
    workspaceAuthorizer: {
      authorize: vi.fn().mockImplementation(async (requested: string) => {
        if (options.authorized === false) {
          throw new WorkspaceAuthorizationError(
            401,
            'authentication_required',
            'Authentication required',
          );
        }
        return requested;
      }),
    },
    successRedirectUrl: 'https://app.botmem.test/connections',
  });
  return { app, connections, callbacks };
}

describe('hosted connections API', () => {
  it('workspaceRoutes_requireStructuredAuthorizationBeforeCallingService', async () => {
    const { app, connections } = build({ authorized: false });
    const response = await app.inject({
      method: 'GET',
      url: `/v2/workspaces/${WORKSPACE_ID}/connections`,
    });

    expect(response.statusCode).toBe(401);
    expect(connections.listConnections).not.toHaveBeenCalled();
    await app.close();
  });

  it('ownTracksSetup_neverEchoesBasicCredentials', async () => {
    const { app, connections } = build();
    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/connections/owntracks`,
      headers: { authorization: 'Bearer opaque' },
      payload: {
        version: 2,
        endpoint: 'https://recorder.example.test/api/0/locations',
        username: 'private-user',
        password: 'private-password',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(connections.connectOwnTracks).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.objectContaining({
        username: 'private-user',
        password: 'private-password',
      }),
    );
    expect(response.body).not.toContain('private-user');
    expect(response.body).not.toContain('private-password');
    await app.close();
  });

  it('oauthCallback_consumesCapabilityAndRedirectsWithoutReflectingCodeOrState', async () => {
    const { app, callbacks } = build();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/connections/oauth/gmail/callback?state=state-capability-1234&code=provider-code-secret',
    });

    expect(callbacks.completeGmail).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'state-capability-1234',
        code: 'provider-code-secret',
      }),
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      'https://app.botmem.test/connections?connector=gmail&status=connected',
    );
    expect(response.body).not.toContain('provider-code-secret');
    expect(response.body).not.toContain('state-capability-1234');
    await app.close();
  });

  it('oauthCallback_whenMalformed_failsClosedBeforeCompletion', async () => {
    const { app, callbacks } = build();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/connections/oauth/outlook/callback?state=short&code=x',
    });

    expect(response.statusCode).toBe(400);
    expect(callbacks.completeOutlook).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        code: 'oauth_callback_failed',
        message: 'Authorization could not be completed. Start a new connection attempt.',
      },
    });
    await app.close();
  });
});
