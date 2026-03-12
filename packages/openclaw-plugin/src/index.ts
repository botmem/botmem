import { PluginApi, PluginConfig } from './types';
import { BotmemClient } from './client';
import { registerMemorySearchTool } from './tools/memory-search';
import { registerMemoryAskTool } from './tools/memory-ask';
import { registerMemoryRememberTool } from './tools/memory-remember';
import { registerMemoryForgetTool } from './tools/memory-forget';
import { registerMemoryTimelineTool } from './tools/memory-timeline';
import { registerPersonContextTool } from './tools/person-context';
import { registerPeopleSearchTool } from './tools/people-search';
import { registerPromptHook } from './hooks/prompt-builder';

export function activate(api: PluginApi) {
  const raw = api.getConfig();
  const config: PluginConfig = {
    apiUrl: String(raw.apiUrl || 'http://localhost:12412'),
    apiKey: String(raw.apiKey || ''),
    defaultLimit: (raw.defaultLimit as number) ?? 10,
    memoryBankId: raw.memoryBankId as string | undefined,
    autoContext: (raw.autoContext as boolean) ?? true,
  };

  const client = new BotmemClient(config.apiUrl, config.apiKey);

  registerMemorySearchTool(api, client, config);
  registerMemoryAskTool(api, client, config);
  registerMemoryRememberTool(api, client);
  registerMemoryForgetTool(api, client);
  registerMemoryTimelineTool(api, client, config);
  registerPersonContextTool(api, client);
  registerPeopleSearchTool(api, client);

  registerPromptHook(api, client, config);
}

export { BotmemClient, BotmemApiError } from './client';
export type { PluginApi, PluginConfig, AgentToolDef, ToolResult } from './types';
