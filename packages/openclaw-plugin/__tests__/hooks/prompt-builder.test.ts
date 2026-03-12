import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerPromptHook } from '../../src/hooks/prompt-builder';
import { BotmemClient } from '../../src/client';
import { PluginApi, PluginConfig } from '../../src/types';
import { BOTMEM_SYSTEM_INSTRUCTIONS } from '../../src/templates/memory-instructions';

function createMockApi() {
  const handlers: Array<{ event: string; handler: (...args: unknown[]) => unknown; opts?: unknown }> = [];
  const api: PluginApi = {
    getConfig: () => ({}),
    registerAgentTool: vi.fn(),
    on: (event, handler, opts) => {
      handlers.push({ event, handler, opts });
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { api, handlers };
}

describe('prompt-builder hook', () => {
  let client: BotmemClient;

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
  });

  it('registers on before_prompt_build event with priority 10', () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key' };

    registerPromptHook(api, client, config);

    expect(handlers).toHaveLength(1);
    expect(handlers[0].event).toBe('before_prompt_build');
    expect(handlers[0].opts).toEqual({ priority: 10 });
  });

  it('prepends system instructions when autoContext is true', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: true };

    vi.spyOn(client, 'getStatus').mockResolvedValueOnce({
      data: {
        memories: { total: 500, byConnector: { gmail: 300, slack: 200 } },
        contacts: { total: 50 },
      },
    });

    registerPromptHook(api, client, config);
    const ctx = { systemPrompt: 'existing prompt' };
    await handlers[0].handler(ctx);

    expect(ctx.systemPrompt).toContain(BOTMEM_SYSTEM_INSTRUCTIONS);
    expect(ctx.systemPrompt).toContain('500 memories');
    expect(ctx.systemPrompt).toContain('gmail: 300');
    expect(ctx.systemPrompt).toContain('slack: 200');
    expect(ctx.systemPrompt).toContain('50 contacts');
    expect(ctx.systemPrompt).toContain('existing prompt');
  });

  it('skips stats when autoContext is false', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: false };

    const spy = vi.spyOn(client, 'getStatus');
    registerPromptHook(api, client, config);
    const ctx = { systemPrompt: 'original' };
    await handlers[0].handler(ctx);

    expect(spy).not.toHaveBeenCalled();
    expect(ctx.systemPrompt).toBe(BOTMEM_SYSTEM_INSTRUCTIONS + 'original');
  });

  it('silently skips stats on API failure', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: true };

    vi.spyOn(client, 'getStatus').mockRejectedValueOnce(new Error('connection refused'));

    registerPromptHook(api, client, config);
    const ctx = { systemPrompt: 'prompt' };
    await handlers[0].handler(ctx);

    expect(ctx.systemPrompt).toBe(BOTMEM_SYSTEM_INSTRUCTIONS + 'prompt');
  });

  it('does nothing if ctx is undefined', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key' };

    registerPromptHook(api, client, config);
    // Should not throw
    await handlers[0].handler(undefined);
  });

  it('handles empty systemPrompt on ctx', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: false };

    registerPromptHook(api, client, config);
    const ctx = {} as { systemPrompt?: string };
    await handlers[0].handler(ctx);

    expect(ctx.systemPrompt).toBe(BOTMEM_SYSTEM_INSTRUCTIONS);
  });

  it('handles status with no byConnector', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: true };

    vi.spyOn(client, 'getStatus').mockResolvedValueOnce({
      data: {
        memories: { total: 100 },
      },
    });

    registerPromptHook(api, client, config);
    const ctx = { systemPrompt: '' };
    await handlers[0].handler(ctx);

    expect(ctx.systemPrompt).toContain('[Botmem: 100 memories]');
    // No contact count in the stats line
    expect(ctx.systemPrompt).not.toMatch(/\d+ contacts/);
  });

  it('skips stats line when total is 0', async () => {
    const { api, handlers } = createMockApi();
    const config: PluginConfig = { apiUrl: 'http://localhost:12412', apiKey: 'key', autoContext: true };

    vi.spyOn(client, 'getStatus').mockResolvedValueOnce({
      data: { memories: { total: 0 } },
    });

    registerPromptHook(api, client, config);
    const ctx = { systemPrompt: '' };
    await handlers[0].handler(ctx);

    // total is 0 (falsy), so no stats appended
    expect(ctx.systemPrompt).toBe(BOTMEM_SYSTEM_INSTRUCTIONS);
  });
});
