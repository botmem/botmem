import { PluginApi } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerPersonContextTool(api: PluginApi, client: BotmemClient) {
  api.registerAgentTool({
    name: 'person_context',
    description:
      'Get full context about a person: contact details, identifiers, recent memories, and interaction stats.',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'The contact ID to look up' },
      },
      required: ['contactId'],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.agentContext(String(params.contactId));
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
