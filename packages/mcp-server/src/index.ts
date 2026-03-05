import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BotmemClient } from './client.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerContactTools } from './tools/contacts.js';
import { registerConnectorTools } from './tools/connectors.js';
import { registerPipelineTools } from './tools/pipeline.js';
import { registerMemoryResources } from './resources/memory.js';

export { BotmemClient } from './client.js';

export function createServer(apiUrl: string): McpServer {
  const client = new BotmemClient(apiUrl);

  const server = new McpServer({
    name: 'botmem',
    version: '0.0.1',
  });

  // Register tools
  registerMemoryTools(server, client);
  registerContactTools(server, client);
  registerConnectorTools(server, client);
  registerPipelineTools(server, client);

  // Register resources
  registerMemoryResources(server, client);

  return server;
}
