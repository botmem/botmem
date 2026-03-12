import { PluginApi, PluginConfig } from '../types';
import { BotmemClient, BotmemApiError } from '../client';
import { toonify } from '../toon';

export function registerMemoryAskTool(api: PluginApi, client: BotmemClient, config: PluginConfig) {
  api.registerAgentTool({
    name: 'memory_ask',
    description:
      'Natural language query with LLM-enriched answer synthesized from matching memories. Best for questions like "What did X say about Y?"',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question about memories' },
        limit: { type: 'number', description: 'Max source memories to consider' },
      },
      required: ['query'],
    },
    execute: async (_id, params) => {
      try {
        const result = await client.agentAsk(
          String(params.query),
          undefined,
          (params.limit as number) ?? config.defaultLimit,
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
