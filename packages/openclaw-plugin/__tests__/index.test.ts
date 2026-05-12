import { describe, it, expect, vi, beforeEach } from 'vitest';
import botmemPlugin from '../src/index';
import { OpenClawPluginApi, OpenClawToolDef } from '../src/types';
import { BOTMEM_SYSTEM_INSTRUCTIONS } from '../src/templates/memory-instructions';

vi.mock('@toon-format/toon', () => ({
  encode: (data: unknown) => `TOON:${JSON.stringify(data)}`,
}));

describe('botmemPlugin', () => {
  let tools: Array<{ def: OpenClawToolDef; opts: unknown }>;
  let events: Array<{ event: string }>;
  let services: Array<{ id: string }>;

  function createMockApi(config: Record<string, unknown> = {}): OpenClawPluginApi {
    tools = [];
    events = [];
    services = [];
    return {
      pluginConfig: {
        apiUrl: 'http://localhost:12412',
        apiKey: 'test-key',
        defaultLimit: 10,
        autoContext: true,
        ...config,
      },
      runtime: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolvePath: (p: string) => p,
      registerTool: (def: unknown, opts: unknown) =>
        tools.push({ def: def as OpenClawToolDef, opts }),
      registerCli: vi.fn(),
      registerService: (svc: { id: string; start: () => void; stop: () => void }) =>
        services.push(svc),
      on: (event: string) => events.push({ event }),
    };
  }

  beforeEach(() => {
    tools = [];
    events = [];
    services = [];
  });

  it('has correct plugin metadata', () => {
    expect(botmemPlugin.id).toBe('botmem');
    expect(botmemPlugin.name).toBe('Botmem Memory');
  });

  it('registers all 7 tools', () => {
    const api = createMockApi();
    botmemPlugin.register(api);

    expect(tools).toHaveLength(7);
    const names = tools.map((t) => (t.opts as { name: string }).name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_ask');
    expect(names).toContain('memory_remember');
    expect(names).toContain('memory_forget');
    expect(names).toContain('memory_timeline');
    expect(names).toContain('person_context');
    expect(names).toContain('people_search');
  });

  it('registers the before_agent_start hook', () => {
    const api = createMockApi();
    botmemPlugin.register(api);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('before_agent_start');
  });

  it('instructs agents to prefer live Botmem for exact identifiers', () => {
    expect(BOTMEM_SYSTEM_INSTRUCTIONS).toContain('use botmem');
    expect(BOTMEM_SYSTEM_INSTRUCTIONS).toContain('before any other recall');
    expect(BOTMEM_SYSTEM_INSTRUCTIONS).toContain('exact identifier');
    expect(BOTMEM_SYSTEM_INSTRUCTIONS).toContain('latest booking');
  });

  it('registers a service', () => {
    const api = createMockApi();
    botmemPlugin.register(api);

    expect(services).toHaveLength(1);
    expect(services[0].id).toBe('botmem');
  });

  it('configSchema.parse validates apiKey is required', () => {
    expect(() => botmemPlugin.configSchema.parse({})).toThrow('apiKey is required');
    expect(() => botmemPlugin.configSchema.parse({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('configSchema.parse returns defaults', () => {
    const config = botmemPlugin.configSchema.parse({ apiKey: 'test' });
    expect(config.apiUrl).toBe('http://localhost:12412');
    expect(config.defaultLimit).toBe(10);
    expect(config.autoContext).toBe(true);
  });
});
