import { PluginApi } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerMemoryRememberTool(api: PluginApi, client: BotmemClient) {
  api.registerAgentTool({
    name: 'memory_remember',
    description:
      'Store a new memory in Botmem. Use for saving important facts, decisions, or information the user wants to remember.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text to store' },
        metadata: { type: 'object', description: 'Optional metadata (key-value pairs)' },
      },
      required: ['text'],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.agentRemember(
          String(params.text),
          params.metadata as Record<string, unknown> | undefined,
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
