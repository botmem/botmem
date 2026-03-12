import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMemoryTimelineTool } from '../../src/tools/memory-timeline';
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

describe('memory_timeline tool', () => {
  let tool: AgentToolDef;
  let client: BotmemClient;
  const config: PluginConfig = {
    apiUrl: 'http://localhost:12412',
    apiKey: 'key',
    defaultLimit: 10,
  };

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
    const { api, tools } = createMockApi();
    registerMemoryTimelineTool(api, client, config);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('memory_timeline');
  });

  it('calls getTimeline and returns toon-encoded result', async () => {
    const mockResult = { items: [{ id: '1', text: 'event' }] };
    vi.spyOn(client, 'getTimeline').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', {});
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('event');
  });

  it('passes all filters to getTimeline', async () => {
    const spy = vi.spyOn(client, 'getTimeline').mockResolvedValueOnce({});

    await tool.execute('call-2', {
      contactId: 'contact-1',
      connectorType: 'gmail',
      sourceType: 'email',
      days: 14,
      limit: 5,
    });

    expect(spy).toHaveBeenCalledWith({
      contactId: 'contact-1',
      connectorType: 'gmail',
      sourceType: 'email',
      days: 14,
      limit: 5,
    });
  });

  it('uses defaultLimit when limit not provided', async () => {
    const spy = vi.spyOn(client, 'getTimeline').mockResolvedValueOnce({});

    await tool.execute('call-3', {});

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('uses provided limit over defaultLimit', async () => {
    const spy = vi.spyOn(client, 'getTimeline').mockResolvedValueOnce({});

    await tool.execute('call-4', { limit: 3 });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'getTimeline').mockRejectedValueOnce(
      new BotmemApiError('Timeout', 504),
    );

    const result = await tool.execute('call-5', {});
    expect(result.content[0].text).toContain('Botmem API error');
    expect(result.content[0].text).toContain('Timeout');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'getTimeline').mockRejectedValueOnce(new RangeError('out'));
    await expect(tool.execute('call-6', {})).rejects.toThrow(RangeError);
  });
});
