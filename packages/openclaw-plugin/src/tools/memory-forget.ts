import { PluginApi } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerMemoryForgetTool(api: PluginApi, client: BotmemClient) {
  api.registerAgentTool({
    name: 'memory_forget',
    description:
      'Delete a specific memory by its ID. Use when the user explicitly asks to remove or forget something.',
    parameters: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'The memory ID to delete' },
      },
      required: ['memoryId'],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.agentForget(String(params.memoryId));
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
