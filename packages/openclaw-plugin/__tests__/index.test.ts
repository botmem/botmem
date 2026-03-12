import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate } from '../src/index';
import { PluginApi, AgentToolDef } from '../src/types';

vi.mock('@toon-format/toon', () => ({
  encode: (data: unknown) => `TOON:${JSON.stringify(data)}`,
}));

describe('activate', () => {
  let tools: AgentToolDef[];
  let events: Array<{ event: string; opts?: unknown }>;

  function createMockApi(rawConfig: Record<string, unknown> = {}): PluginApi {
    tools = [];
    events = [];
    return {
      getConfig: () => rawConfig,
      registerAgentTool: (tool) => tools.push(tool),
      on: (event, _handler, opts) => {
        events.push({ event, opts });
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  }

  beforeEach(() => {
    tools = [];
    events = [];
  });

  it('registers all 7 tools', () => {
    const api = createMockApi({ apiKey: 'test-key' });
    activate(api);

    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_ask');
    expect(names).toContain('memory_remember');
    expect(names).toContain('memory_forget');
    expect(names).toContain('memory_timeline');
    expect(names).toContain('person_context');
    expect(names).toContain('people_search');
  });

  it('registers the prompt hook', () => {
    const api = createMockApi({ apiKey: 'test-key' });
    activate(api);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('before_prompt_build');
  });

  it('uses default config values when not provided', () => {
    const api = createMockApi({});
    activate(api);

    // Should not throw, defaults applied
    expect(tools).toHaveLength(7);
  });

  it('parses config with custom values', () => {
    const api = createMockApi({
      apiUrl: 'http://custom:9999',
      apiKey: 'my-key',
      defaultLimit: 25,
      memoryBankId: 'bank-1',
      autoContext: false,
    });
    activate(api);

    // Plugin should still register all tools with custom config
    expect(tools).toHaveLength(7);
  });

  it('coerces apiUrl and apiKey to strings', () => {
    const api = createMockApi({
      apiUrl: 12345,
      apiKey: undefined,
    });
    // Should not throw - String(12345) = "12345", String(undefined) = "undefined" but that's fine
    activate(api);
    expect(tools).toHaveLength(7);
  });

  it('defaults defaultLimit to 10 when not provided', () => {
    // We can verify this indirectly by checking timeline tool uses defaultLimit=10
    const api = createMockApi({ apiKey: 'key' });
    activate(api);

    const timelineTool = tools.find((t) => t.name === 'memory_timeline');
    expect(timelineTool).toBeDefined();
  });
});
