import type { SearchResponse } from '@botmem-v2/contracts';
import type {
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from '@botmem-v2/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMcpApi } from './mcp-api.js';
import { WorkspaceAuthorizationError, type WorkspaceAuthorizer } from './search-api.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const RESPONSE: SearchResponse = {
  version: 2,
  queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  items: [],
  coverage: { partial: false, lanes: [] },
  found: 0,
  tookMs: 2,
};

const openApps: ReturnType<typeof Fastify>[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(openApps.splice(0).map((app) => app.close()));
});

function build(
  authorizer: WorkspaceAuthorizer,
  search: SearchApplicationService,
  optional: {
    readonly connectionReadAuthorizer?: WorkspaceAuthorizer;
    readonly deviceReadAuthorizer?: WorkspaceAuthorizer;
    readonly connections?: ConnectionsApplicationService;
    readonly devices?: DevicesApplicationService;
  } = {},
) {
  const app = Fastify({ logger: false });
  registerMcpApi(app, {
    search,
    workspaceAuthorizer: authorizer,
    publicBaseUrl: 'http://127.0.0.1',
    ...optional,
  });
  openApps.push(app);
  return app;
}

describe('MCP Streamable HTTP API', () => {
  it('clientInitializeAndCall_whenBearerOwnsWorkspace_returnsCanonicalResult', async () => {
    let calls = 0;
    const app = build(
      {
        authorize: async (workspaceId, credentials) => {
          if (credentials.authorizationHeader !== 'Bearer valid-token') {
            throw new WorkspaceAuthorizationError(
              401,
              'authentication_required',
              'Authentication required',
            );
          }
          return workspaceId;
        },
      },
      {
        search: async () => {
          calls += 1;
          return RESPONSE;
        },
      },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/v2/workspaces/${WORKSPACE_ID}/mcp`),
      { requestInit: { headers: { authorization: 'Bearer valid-token' } } },
    );
    const client = new Client({ name: 'botmem-http-test', version: '1.0.0' });
    openClients.push(client);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['search']);
    const response = await client.callTool({ name: 'search', arguments: { query: 'launch' } });

    expect(calls).toBe(1);
    expect(response.structuredContent).toEqual(RESPONSE);
  });

  it('request_whenBearerIsMissing_truthfullyRequestsThePATSearchScope', async () => {
    const app = build(
      {
        authorize: async () => {
          throw new WorkspaceAuthorizationError(
            401,
            'authentication_required',
            'Authentication required',
          );
        },
      },
      { search: async () => RESPONSE },
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/mcp`,
      headers: { host: '127.0.0.1' },
      payload: { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer scope="botmem:search"');
    const metadata = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource/v2/workspaces/${WORKSPACE_ID}/mcp`,
    });
    expect(metadata.statusCode).toBe(404);
  });

  it('request_whenBrowserOriginIsUntrusted_rejectsBeforeAuthorization', async () => {
    let authorizationCalls = 0;
    const app = build(
      {
        authorize: async (workspaceId) => {
          authorizationCalls += 1;
          return workspaceId;
        },
      },
      { search: async () => RESPONSE },
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v2/workspaces/${WORKSPACE_ID}/mcp`,
      headers: { host: '127.0.0.1', origin: 'https://attacker.invalid' },
      payload: { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    });

    expect(response.statusCode).toBe(403);
    expect(authorizationCalls).toBe(0);
  });

  it('clientListTools_whenPATHasStatusScopes_advertisesOnlyItsAuthorizedCapabilities', async () => {
    const allow: WorkspaceAuthorizer = { authorize: async (workspaceId) => workspaceId };
    const app = build(
      allow,
      { search: async () => RESPONSE },
      {
        connectionReadAuthorizer: allow,
        deviceReadAuthorizer: allow,
        connections: { listConnections: async () => ({ version: 2, items: [] }) },
        devices: { listDevices: async () => ({ version: 2, items: [] }) },
      },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/v2/workspaces/${WORKSPACE_ID}/mcp`),
      { requestInit: { headers: { authorization: 'Bearer status-token' } } },
    );
    const client = new Client({ name: 'botmem-status-test', version: '1.0.0' });
    openClients.push(client);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'connections.list',
      'devices.status',
      'search',
    ]);
  });
});
