import {
  ConnectionListResponseSchema,
  ConnectionListToolInputSchema,
  DeviceListResponseSchema,
  DeviceListToolInputSchema,
  SearchResponseSchema,
  SearchToolInputSchema,
  parseWorkspaceId,
} from '@botmem-v2/contracts';
import type {
  ConnectionsApplicationService,
  DevicesApplicationService,
  SearchApplicationService,
} from '@botmem-v2/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpSearchTool } from './search-tool.js';

/**
 * Creates a read-only MCP protocol server bound to one already-authorized
 * workspace. Authentication and workspace binding happen before this factory
 * is called by the HTTP or stdio driving adapter.
 */
export function createBotmemMcpServer(
  search: SearchApplicationService,
  workspaceId: string,
  connections?: ConnectionsApplicationService,
  devices?: DevicesApplicationService,
): McpServer {
  const validatedWorkspaceId = parseWorkspaceId(workspaceId);
  const searchTool = createMcpSearchTool(search, validatedWorkspaceId);
  const server = new McpServer(
    { name: 'botmem', version: '2.0.0' },
    {
      instructions:
        'Botmem is read-only. Search results include explicit hosted/device coverage; never describe a partial result as complete.',
    },
  );

  server.registerTool(
    searchTool.name,
    {
      title: 'Search personal context',
      description: searchTool.description,
      inputSchema: SearchToolInputSchema,
      outputSchema: SearchResponseSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await searchTool.invoke(input);
      return {
        content: result.content,
        structuredContent: { ...result.structuredContent },
      };
    },
  );

  if (connections) {
    server.registerTool(
      'connections.list',
      {
        title: 'List hosted connections',
        description:
          'List Gmail, Outlook, and OwnTracks connection and searchable readiness states.',
        inputSchema: ConnectionListToolInputSchema,
        outputSchema: ConnectionListResponseSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = ConnectionListResponseSchema.parse(
          await connections.listConnections(validatedWorkspaceId),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      },
    );
  }

  if (devices) {
    server.registerTool(
      'devices.status',
      {
        title: 'List device status',
        description:
          'List paired Macs with online/offline state and explicit iMessage/WhatsApp readiness.',
        inputSchema: DeviceListToolInputSchema,
        outputSchema: DeviceListResponseSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = DeviceListResponseSchema.parse(
          await devices.listDevices(validatedWorkspaceId),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      },
    );
  }

  return server;
}
