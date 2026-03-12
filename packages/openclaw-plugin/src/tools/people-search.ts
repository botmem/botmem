import { PluginApi } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerPeopleSearchTool(api: PluginApi, client: BotmemClient) {
  api.registerAgentTool({
    name: 'people_search',
    description:
      'Find contacts by name, email, or phone number. Use before person_context to discover contact IDs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, email, or phone to search for' },
        limit: { type: 'number', description: 'Max results to return' },
      },
      required: ['query'],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.searchContacts(
          String(params.query),
          params.limit as number | undefined,
        );
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
