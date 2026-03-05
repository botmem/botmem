import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotmemClient } from '../client.js';

export function registerMemoryResources(server: McpServer, client: BotmemClient): void {
  server.resource(
    'memory-stats',
    'memory://stats',
    {
      description: 'Live memory database statistics including total count and breakdowns by source, connector, and factuality.',
      mimeType: 'text/plain',
    },
    async () => {
      try {
        const stats = await client.getMemoryStats();
        const lines: string[] = [
          `Total memories: ${stats.total}`,
          '',
          'By source type:',
          ...Object.entries(stats.bySource).map(([k, v]) => `  ${k}: ${v}`),
          '',
          'By connector:',
          ...Object.entries(stats.byConnector).map(([k, v]) => `  ${k}: ${v}`),
          '',
          'By factuality:',
          ...Object.entries(stats.byFactuality).map(([k, v]) => `  ${k}: ${v}`),
        ];
        return { contents: [{ uri: 'memory://stats', text: lines.join('\n'), mimeType: 'text/plain' }] };
      } catch (err) {
        return {
          contents: [{
            uri: 'memory://stats',
            text: `Error fetching stats: ${err instanceof Error ? err.message : String(err)}`,
            mimeType: 'text/plain',
          }],
        };
      }
    },
  );

  server.resource(
    'memory-recent',
    'memory://recent',
    {
      description: 'The 10 most recently created memories.',
      mimeType: 'text/plain',
    },
    async () => {
      try {
        const result = await client.listMemories({ limit: 10 });
        if (result.items.length === 0) {
          return { contents: [{ uri: 'memory://recent', text: 'No memories yet.', mimeType: 'text/plain' }] };
        }

        const lines: string[] = [
          `${result.items.length} most recent memories (of ${result.total} total):`,
          '',
        ];

        for (const m of result.items) {
          lines.push(`[${m.sourceType}/${m.connectorType}] ${m.text.slice(0, 150)}${m.text.length > 150 ? '...' : ''}`);
          if (m.eventTime) lines.push(`  Time: ${m.eventTime}`);
          lines.push(`  ID: ${m.id}`);
          lines.push('');
        }

        return { contents: [{ uri: 'memory://recent', text: lines.join('\n'), mimeType: 'text/plain' }] };
      } catch (err) {
        return {
          contents: [{
            uri: 'memory://recent',
            text: `Error fetching recent memories: ${err instanceof Error ? err.message : String(err)}`,
            mimeType: 'text/plain',
          }],
        };
      }
    },
  );
}
