import { PluginApi, PluginConfig } from '../types';
import { BotmemClient } from '../client';
import { BOTMEM_SYSTEM_INSTRUCTIONS } from '../templates/memory-instructions';

export function registerPromptHook(api: PluginApi, client: BotmemClient, config: PluginConfig) {
  api.on(
    'before_prompt_build',
    async (...args: unknown[]) => {
      const ctx = args[0] as { systemPrompt?: string } | undefined;
      if (!ctx) return;

      let instructions = BOTMEM_SYSTEM_INSTRUCTIONS;

      if (config.autoContext !== false) {
        try {
          const status = (await client.getStatus()) as {
            data?: {
              memories?: { total?: number; byConnector?: Record<string, number> };
              contacts?: { total?: number };
            };
          };
          const mem = status.data?.memories;
          const contacts = status.data?.contacts;
          if (mem?.total) {
            const connectors = mem.byConnector
              ? Object.entries(mem.byConnector)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')
              : '';
            instructions += `\n[Botmem: ${mem.total} memories${connectors ? ` (${connectors})` : ''}${contacts?.total ? `, ${contacts.total} contacts` : ''}]\n`;
          }
        } catch {
          // API unreachable — silently skip stats
        }
      }

      ctx.systemPrompt = instructions + (ctx.systemPrompt || '');
    },
    { priority: 10 },
  );
}
