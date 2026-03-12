import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMemoryAskTool } from '../../src/tools/memory-ask';
import { BotmemClient, BotmemApiError } from '../../src/client';
import { PluginApi, PluginConfig, AgentToolDef } from '../../src/types';

vi.mock('@toon-format/toon', () => ({
  encode: (data: unknown) => `TOON:${JSON.stringify(data)}`,
}));

function createMockApi() {
  const tools: AgentToolDef[] = [];
  const api: PluginApi = {
    getConfig: () => ({}),
    registerAgentTool: (tool) => tools.push(tool),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { api, tools };
}

describe('memory_ask tool', () => {
  let tool: AgentToolDef;
  let client: BotmemClient;

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
    const { api, tools } = createMockApi();
    const config: PluginConfig = {
      apiUrl: 'http://localhost:12412',
      apiKey: 'key',
      defaultLimit: 10,
    };
    registerMemoryAskTool(api, client, config);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('memory_ask');
  });

  it('calls agentAsk and returns toon-encoded result', async () => {
    const mockResult = { answer: 'The meeting is at 3pm', results: [] };
    vi.spyOn(client, 'agentAsk').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', { query: 'when is the meeting?' });
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('3pm');
  });

  it('uses defaultLimit when limit not provided', async () => {
    const spy = vi.spyOn(client, 'agentAsk').mockResolvedValueOnce({});
    await tool.execute('call-2', { query: 'test' });
    expect(spy).toHaveBeenCalledWith('test', undefined, 10);
  });

  it('uses provided limit over default', async () => {
    const spy = vi.spyOn(client, 'agentAsk').mockResolvedValueOnce({});
    await tool.execute('call-3', { query: 'test', limit: 3 });
    expect(spy).toHaveBeenCalledWith('test', undefined, 3);
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'agentAsk').mockRejectedValueOnce(new BotmemApiError('Unauthorized', 401));

    const result = await tool.execute('call-4', { query: 'test' });
    expect(result.content[0].text).toContain('Botmem API error');
    expect(result.content[0].text).toContain('Unauthorized');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'agentAsk').mockRejectedValueOnce(new Error('network'));
    await expect(tool.execute('call-5', { query: 'test' })).rejects.toThrow('network');
  });
});
