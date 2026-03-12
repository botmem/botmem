import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMemoryForgetTool } from '../../src/tools/memory-forget';
import { BotmemClient, BotmemApiError } from '../../src/client';
import { PluginApi, AgentToolDef } from '../../src/types';

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

describe('memory_forget tool', () => {
  let tool: AgentToolDef;
  let client: BotmemClient;

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
    const { api, tools } = createMockApi();
    registerMemoryForgetTool(api, client);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('memory_forget');
  });

  it('calls agentForget and returns toon-encoded result', async () => {
    const mockResult = { deleted: true, id: 'mem-123' };
    vi.spyOn(client, 'agentForget').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', { memoryId: 'mem-123' });
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('mem-123');
  });

  it('passes memoryId to agentForget', async () => {
    const spy = vi.spyOn(client, 'agentForget').mockResolvedValueOnce({});

    await tool.execute('call-2', { memoryId: 'abc-def' });

    expect(spy).toHaveBeenCalledWith('abc-def');
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'agentForget').mockRejectedValueOnce(
      new BotmemApiError('Not found', 404),
    );

    const result = await tool.execute('call-3', { memoryId: 'bad-id' });
    expect(result.content[0].text).toContain('Botmem API error');
    expect(result.content[0].text).toContain('Not found');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'agentForget').mockRejectedValueOnce(new Error('network'));
    await expect(tool.execute('call-4', { memoryId: 'x' })).rejects.toThrow('network');
  });
});
