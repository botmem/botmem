import { PluginApi, PluginConfig } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerMemorySearchTool(
  api: PluginApi,
  client: BotmemClient,
  config: PluginConfig,
) {
  api.registerAgentTool({
    name: 'memory_search',
    description:
      'Semantic search across all memories (emails, messages, photos, locations). Returns ranked results with relevance scores.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        sourceType: {
          type: 'string',
          description: 'Filter by source type (email, message, photo, location)',
        },
        connectorType: {
          type: 'string',
          description: 'Filter by connector (gmail, slack, whatsapp, imessage, photos-immich)',
        },
        contactId: { type: 'string', description: 'Filter by contact ID' },
        from: { type: 'string', description: 'Start date (ISO 8601)' },
        to: { type: 'string', description: 'End date (ISO 8601)' },
        limit: { type: 'number', description: 'Max results to return' },
      },
      required: ['query'],
    },
    execute: async (_id, params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.sourceType) filters.sourceType = String(params.sourceType);
        if (params.connectorType) filters.connectorType = String(params.connectorType);
        if (params.contactId) filters.contactId = String(params.contactId);
        if (params.from) filters.from = String(params.from);
        if (params.to) filters.to = String(params.to);

        const results = await client.searchMemories(
          String(params.query),
          Object.keys(filters).length ? filters : undefined,
          (params.limit as number) ?? config.defaultLimit,
          config.memoryBankId,
        );
        return { content: [{ type: 'text', text: toonify(results) }] };
      } catch (err) {
        if (err instanceof BotmemApiError) {
          return { content: [{ type: 'text', text: `Botmem API error: ${err.message}` }] };
        }
        throw err;
      }
    },
  });
}
