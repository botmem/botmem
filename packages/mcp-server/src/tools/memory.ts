import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotmemClient, SearchResult, Memory } from '../client.js';

function formatMemory(m: Memory): string {
  const lines: string[] = [];
  lines.push(`ID: ${m.id}`);
  lines.push(`Text: ${m.text}`);
  lines.push(`Source: ${m.sourceType} (${m.connectorType})`);
  if (m.eventTime) lines.push(`Time: ${m.eventTime}`);
  if (m.factuality) {
    try {
      const f = JSON.parse(m.factuality);
      lines.push(`Factuality: ${f.label} (${((f.confidence ?? 0) * 100).toFixed(0)}%)`);
    } catch { /* skip */ }
  }
  if (m.importance != null) lines.push(`Importance: ${m.importance}`);
  lines.push(`Embedding: ${m.embeddingStatus}`);
  return lines.join('\n');
}

function formatSearchResult(r: SearchResult, idx: number): string {
  const lines: string[] = [];
  lines.push(`--- Result ${idx + 1} (score: ${r.weights.final.toFixed(4)}) ---`);
  lines.push(`ID: ${r.id}`);
  lines.push(`Text: ${r.text}`);
  lines.push(`Source: ${r.sourceType} (${r.connectorType})`);
  if (r.eventTime) lines.push(`Time: ${r.eventTime}`);
  lines.push(`Scores: semantic=${r.weights.semantic.toFixed(3)} recency=${r.weights.recency.toFixed(3)} importance=${r.weights.importance.toFixed(3)} trust=${r.weights.trust.toFixed(3)}`);
  return lines.join('\n');
}

export function registerMemoryTools(server: McpServer, client: BotmemClient): void {
  server.tool(
    'memory_search',
    'Search memories semantically. Returns ranked results with relevance scores.',
    {
      query: z.string().describe('The search query text'),
      sourceType: z.string().optional().describe('Filter by source type (email, message, photo, location, manual)'),
      connectorType: z.string().optional().describe('Filter by connector type (gmail, slack, whatsapp, imessage, photos-immich, manual)'),
      contactId: z.string().optional().describe('Filter by contact ID'),
      factualityLabel: z.enum(['FACT', 'UNVERIFIED', 'FICTION']).optional().describe('Filter by factuality label'),
      limit: z.number().default(20).describe('Maximum number of results'),
    },
    async ({ query, sourceType, connectorType, contactId, factualityLabel, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (sourceType) filters.sourceType = sourceType;
        if (connectorType) filters.connectorType = connectorType;
        if (contactId) filters.contactId = contactId;
        if (factualityLabel) filters.factualityLabel = factualityLabel;

        const results = await client.searchMemories(query, Object.keys(filters).length > 0 ? filters : undefined, limit);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No memories found for query: "${query}"` }] };
        }

        const text = [
          `Found ${results.length} memories for "${query}":`,
          '',
          ...results.map((r, i) => formatSearchResult(r, i)),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching memories: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_insert',
    'Add a new memory to the system. The memory will be embedded and enriched automatically.',
    {
      text: z.string().describe('The memory text content'),
      sourceType: z.string().default('manual').describe('Source type (default: manual)'),
      connectorType: z.string().default('manual').describe('Connector type (default: manual)'),
    },
    async ({ text, sourceType, connectorType }) => {
      try {
        const memory = await client.insertMemory(text, sourceType, connectorType);
        return {
          content: [{
            type: 'text',
            text: `Memory created successfully.\n\n${formatMemory(memory)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error inserting memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_get',
    'Get a specific memory by its ID.',
    {
      id: z.string().describe('The memory UUID'),
    },
    async ({ id }) => {
      try {
        const memory = await client.getMemory(id);
        return { content: [{ type: 'text', text: formatMemory(memory) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_list',
    'List recent memories with optional filters.',
    {
      limit: z.number().default(20).describe('Maximum number of results'),
      offset: z.number().default(0).describe('Offset for pagination'),
      connectorType: z.string().optional().describe('Filter by connector type'),
      sourceType: z.string().optional().describe('Filter by source type'),
    },
    async ({ limit, offset, connectorType, sourceType }) => {
      try {
        const result = await client.listMemories({ limit, offset, connectorType, sourceType });
        if (result.items.length === 0) {
          return { content: [{ type: 'text', text: 'No memories found.' }] };
        }

        const text = [
          `Showing ${result.items.length} of ${result.total} memories:`,
          '',
          ...result.items.map((m, i) => `--- ${i + 1} ---\n${formatMemory(m)}`),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error listing memories: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_delete',
    'Delete a memory by its ID.',
    {
      id: z.string().describe('The memory UUID to delete'),
    },
    async ({ id }) => {
      try {
        await client.deleteMemory(id);
        return { content: [{ type: 'text', text: `Memory ${id} deleted successfully.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error deleting memory: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_stats',
    'Get memory database statistics including counts by source, connector, and factuality.',
    {},
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
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting stats: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_graph',
    'Get the memory relationship graph showing how memories are linked (supports, contradicts, related).',
    {},
    async () => {
      try {
        const graph = await client.getMemoryGraph();
        const lines: string[] = [
          `Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
          '',
          'Nodes:',
          ...graph.nodes.slice(0, 50).map(n => `  [${n.type}] ${n.id}: ${n.label}`),
          ...(graph.nodes.length > 50 ? [`  ... and ${graph.nodes.length - 50} more`] : []),
          '',
          'Edges:',
          ...graph.edges.slice(0, 50).map(e => `  ${e.source} --${e.type}--> ${e.target}`),
          ...(graph.edges.length > 50 ? [`  ... and ${graph.edges.length - 50} more`] : []),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting graph: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
