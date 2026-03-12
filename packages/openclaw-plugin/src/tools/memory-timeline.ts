import { PluginApi, PluginConfig } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerMemoryTimelineTool(
  api: PluginApi,
  client: BotmemClient,
  config: PluginConfig,
) {
  api.registerAgentTool({
    name: 'memory_timeline',
    description:
      'Chronological view of memories. Useful for "what happened last week" or "show me recent emails from X".',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Filter by contact ID' },
        connectorType: {
          type: 'string',
          description: 'Filter by connector (gmail, slack, whatsapp, etc.)',
        },
        sourceType: {
          type: 'string',
          description: 'Filter by source type (email, message, photo, location)',
        },
        days: { type: 'number', description: 'Number of days to look back (default: 7)' },
        limit: { type: 'number', description: 'Max results to return' },
      },
      required: [],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.getTimeline({
          contactId: params.contactId as string | undefined,
          connectorType: params.connectorType as string | undefined,
          sourceType: params.sourceType as string | undefined,
          days: params.days as number | undefined,
          limit: (params.limit as number) ?? config.defaultLimit,
        });
        return { content: [{ type: 'text', text: toonify(result) }] };
      } catch (err) {
        if (err instanceof BotmemApiError) {
          return { content: [{ type: 'text', text: `Botmem API error: ${err.message}` }] };
        }
        throw err;
      }
    },
  });
}
