import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerPersonContextTool } from '../../src/tools/person-context';
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

describe('person_context tool', () => {
  let tool: AgentToolDef;
  let client: BotmemClient;

  beforeEach(() => {
    client = new BotmemClient('http://localhost:12412', 'key');
    const { api, tools } = createMockApi();
    registerPersonContextTool(api, client);
    tool = tools[0];
  });

  it('registers with correct name', () => {
    expect(tool.name).toBe('person_context');
  });

  it('calls agentContext and returns toon-encoded result', async () => {
    const mockResult = { name: 'Alice', email: 'alice@example.com', memories: [] };
    vi.spyOn(client, 'agentContext').mockResolvedValueOnce(mockResult);

    const result = await tool.execute('call-1', { contactId: 'c-1' });
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('Alice');
  });

  it('passes contactId to agentContext', async () => {
    const spy = vi.spyOn(client, 'agentContext').mockResolvedValueOnce({});

    await tool.execute('call-2', { contactId: 'contact-abc' });

    expect(spy).toHaveBeenCalledWith('contact-abc');
  });

  it('returns friendly error on BotmemApiError', async () => {
    vi.spyOn(client, 'agentContext').mockRejectedValueOnce(
      new BotmemApiError('Not found', 404),
    );

    const result = await tool.execute('call-3', { contactId: 'bad' });
    expect(result.content[0].text).toContain('Botmem API error');
    expect(result.content[0].text).toContain('Not found');
  });

  it('rethrows non-API errors', async () => {
    vi.spyOn(client, 'agentContext').mockRejectedValueOnce(new TypeError('bad'));
    await expect(tool.execute('call-4', { contactId: 'x' })).rejects.toThrow(TypeError);
  });
});
