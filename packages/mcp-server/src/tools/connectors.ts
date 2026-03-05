import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotmemClient } from '../client.js';

export function registerConnectorTools(server: McpServer, client: BotmemClient): void {
  server.tool(
    'connector_list',
    'List all available connectors and their auth types.',
    {},
    async () => {
      try {
        const connectors = await client.listConnectors();
        if (connectors.length === 0) {
          return { content: [{ type: 'text', text: 'No connectors registered.' }] };
        }

        const text = [
          `${connectors.length} connectors available:`,
          '',
          ...connectors.map(c => {
            const lines = [`  ${c.name} (${c.id})`];
            lines.push(`    Auth: ${c.authType}`);
            if (c.description) lines.push(`    ${c.description}`);
            return lines.join('\n');
          }),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error listing connectors: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
