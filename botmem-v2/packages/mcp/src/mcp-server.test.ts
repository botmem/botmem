import type {
  ConnectionListResponse,
  DeviceListResponse,
  SearchResponse,
} from '@botmem-v2/contracts';
import type {
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from '@botmem-v2/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createBotmemMcpServer } from './mcp-server.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const RESPONSE: SearchResponse = {
  version: 2,
  queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
  items: [],
  coverage: {
    partial: true,
    lanes: [
      {
        laneId: 'device:df381211-58ea-4558-a36f-a2a3202bc682',
        placement: 'device',
        deviceId: 'df381211-58ea-4558-a36f-a2a3202bc682',
        status: 'offline',
        retryable: true,
        returned: 0,
        tookMs: 2,
        reasonCode: 'device_disconnected',
      },
    ],
  },
  found: 0,
  tookMs: 3,
};
const CONNECTIONS: ConnectionListResponse = { version: 2, items: [] };
const DEVICES: DeviceListResponse = { version: 2, items: [] };

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((value) => value.close()));
});

describe('Botmem MCP protocol server', () => {
  it('initializeListAndCall_whenBoundToWorkspace_returnsCanonicalStructuredResult', async () => {
    let receivedWorkspace: string | undefined;
    const search: SearchApplicationService = {
      search: async (workspaceId) => {
        receivedWorkspace = workspaceId;
        return RESPONSE;
      },
    };
    const server = createBotmemMcpServer(search, WORKSPACE_ID);
    const client = new Client({ name: 'botmem-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools).toEqual([
      expect.objectContaining({
        name: 'search',
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
      }),
    ]);
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'launch' },
    });

    expect(receivedWorkspace).toBe(WORKSPACE_ID);
    expect(result.structuredContent).toEqual(RESPONSE);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(RESPONSE) }]);
  });

  it('callTool_whenInputContainsPrivateThreshold_rejectsBeforeSearch', async () => {
    let calls = 0;
    const search: SearchApplicationService = {
      search: async () => {
        calls += 1;
        return RESPONSE;
      },
    };
    const server = createBotmemMcpServer(search, WORKSPACE_ID);
    const client = new Client({ name: 'botmem-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'launch', minimumScore: 0.9 },
    });

    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it('connectionsList_whenAdapterIsComposed_returnsCanonicalReadOnlyState', async () => {
    let receivedWorkspace: string | undefined;
    const search: SearchApplicationService = { search: async () => RESPONSE };
    const connections = {
      listConnections: async (workspaceId: string) => {
        receivedWorkspace = workspaceId;
        return CONNECTIONS;
      },
    } as ConnectionsApplicationService;
    const server = createBotmemMcpServer(search, WORKSPACE_ID, connections);
    const client = new Client({ name: 'botmem-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['connections.list', 'search']);
    const result = await client.callTool({ name: 'connections.list', arguments: {} });

    expect(receivedWorkspace).toBe(WORKSPACE_ID);
    expect(result.structuredContent).toEqual(CONNECTIONS);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(CONNECTIONS) }]);
  });

  it('devicesStatus_whenAdapterIsComposed_returnsCanonicalReadOnlyState', async () => {
    let receivedWorkspace: string | undefined;
    const search: SearchApplicationService = { search: async () => RESPONSE };
    const devices: DevicesApplicationService = {
      listDevices: async (workspaceId) => {
        receivedWorkspace = workspaceId;
        return DEVICES;
      },
    };
    const server = createBotmemMcpServer(search, WORKSPACE_ID, undefined, devices);
    const client = new Client({ name: 'botmem-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'devices.status', arguments: {} });

    expect(receivedWorkspace).toBe(WORKSPACE_ID);
    expect(result.structuredContent).toEqual(DEVICES);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(DEVICES) }]);
  });
});
