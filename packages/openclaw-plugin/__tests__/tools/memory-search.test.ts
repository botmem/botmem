import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMemorySearchTool } from '../../src/tools/memory-search';
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

describe('memory_search tool', () => {
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
    registerMemorySearchTool(api, client, config);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('memory_search');
  });

  it('calls searchMemories and returns toon-encoded result', async () => {
    const mockResult = { items: [{ id: '1', text: 'hello' }], fallback: false };
    vi.spyOn(client, 'searchMemories').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', { query: 'hello' });
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('hello');
  });

  it('passes filters to searchMemories', async () => {
    const spy = vi.spyOn(client, 'searchMemories').mockResolvedValueOnce({ items: [] });

    await tool.execute('call-2', {
      query: 'test',
      sourceType: 'email',
      connectorType: 'gmail',
      from: '2025-01-01',
      limit: 5,
    });

    expect(spy).toHaveBeenCalledWith(
      'test',
      { sourceType: 'email', connectorType: 'gmail', from: '2025-01-01' },
      5,
      undefined,
    );
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'searchMemories').mockRejectedValueOnce(
      new BotmemApiError('Server error', 500),
    );

    const result = await tool.execute('call-3', { query: 'test' });
    expect(result.content[0].text).toContain('Botmem API error');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'searchMemories').mockRejectedValueOnce(new TypeError('bad'));
    await expect(tool.execute('call-4', { query: 'test' })).rejects.toThrow(TypeError);
  });
});
