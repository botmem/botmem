import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMemoryRememberTool } from '../../src/tools/memory-remember';
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

describe('memory_remember tool', () => {
  let tool: AgentToolDef;
  let client: BotmemClient;

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
    const { api, tools } = createMockApi();
    registerMemoryRememberTool(api, client);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('memory_remember');
  });

  it('calls agentRemember and returns toon-encoded result', async () => {
    const mockResult = { id: 'mem-1', stored: true };
    vi.spyOn(client, 'agentRemember').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', { text: 'Remember this fact' });
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('mem-1');
  });

  it('passes text and metadata to agentRemember', async () => {
    const spy = vi.spyOn(client, 'agentRemember').mockResolvedValueOnce({});
    const metadata = { category: 'work', priority: 'high' };

    await tool.execute('call-2', { text: 'important note', metadata });

    expect(spy).toHaveBeenCalledWith('important note', metadata);
  });

  it('passes undefined metadata when not provided', async () => {
    const spy = vi.spyOn(client, 'agentRemember').mockResolvedValueOnce({});

    await tool.execute('call-3', { text: 'just text' });

    expect(spy).toHaveBeenCalledWith('just text', undefined);
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'agentRemember').mockRejectedValueOnce(
      new BotmemApiError('Server error', 500),
    );

    const result = await tool.execute('call-4', { text: 'test' });
    expect(result.content[0].text).toContain('Botmem API error');
    expect(result.content[0].text).toContain('Server error');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'agentRemember').mockRejectedValueOnce(new TypeError('bad'));
    await expect(tool.execute('call-5', { text: 'test' })).rejects.toThrow(TypeError);
  });
});
