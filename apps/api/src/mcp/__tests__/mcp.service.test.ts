import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpService } from '../mcp.service';
import type { MemoryService } from '../../memory/memory.service';
import type { AgentService } from '../../agent/agent.service';
import type { DbService } from '../../db/db.service';

function createService() {
  const memoryService = {
    needsRecoveryKey: vi.fn().mockResolvedValue(false),
    search: vi.fn().mockResolvedValue({ items: [], fallback: false }),
  } as unknown as MemoryService;
  const agentService = {
    ask: vi.fn().mockResolvedValue({ results: [], query: 'q' }),
  } as unknown as AgentService;
  const dbService = {
    withUserId: vi.fn().mockImplementation((_userId: string, fn: () => unknown) => fn()),
  } as unknown as DbService;
  const service = new McpService(memoryService, agentService, dbService);
  return { service, memoryService, agentService };
}

function getTool(server: unknown, name: string) {
  return (server as { _registeredTools: Record<string, { handler: (params: unknown) => unknown }> })
    ._registeredTools[name];
}

describe('McpService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets startup instructions that identify botmem and tool usage', () => {
    const { service } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const instructions = (server as { server: { _instructions?: string } }).server._instructions;

    expect(instructions).toContain('botmem');
    expect(instructions).toContain('Use search');
    expect(instructions).toContain('Use ask');
    expect(instructions).toContain('date_from');
    expect(instructions).toContain('date_to');

    service.onModuleDestroy();
  });

  it('passes explicit date filters to search', async () => {
    const { service, memoryService } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const search = getTool(server, 'search');

    await search.handler({
      query: 'travel',
      source_type: 'email',
      connector_type: 'gmail',
      date_from: '2026-04-01T00:00:00.000Z',
      date_to: '2026-05-01T00:00:00.000Z',
      limit: 10,
    });

    expect(memoryService.search).toHaveBeenCalledWith(
      'travel',
      {
        sourceType: 'email',
        connectorType: 'gmail',
        contactId: undefined,
        from: '2026-04-01T00:00:00.000Z',
        to: '2026-05-01T00:00:00.000Z',
      },
      10,
      'user-1',
    );

    service.onModuleDestroy();
  });

  it('truncates long text and collapses duplicate memories in MCP output', () => {
    const { service } = createService();
    const text = 'x'.repeat(100);
    const output = (
      service as unknown as {
        formatMcpResponse: (data: unknown, textMaxLength?: number) => string;
      }
    ).formatMcpResponse(
      {
        items: [
          {
            id: 'low',
            connectorType: 'gmail',
            text,
            eventTime: '2026-04-01T00:00:00.000Z',
            metadata: JSON.stringify({ messageId: '<same@example.com>' }),
            score: 0.2,
          },
          {
            id: 'high',
            connectorType: 'gmail',
            text,
            eventTime: '2026-04-01T00:00:00.000Z',
            metadata: JSON.stringify({ messageId: '<same@example.com>' }),
            score: 0.9,
          },
        ],
      },
      12,
    );
    const parsed = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('high');
    expect(parsed.items[0].duplicate_count).toBe(2);
    expect(parsed.items[0].text).toBe('xxxxxxxxxxxx');
    expect(parsed.items[0].text_truncated).toBe(true);

    service.onModuleDestroy();
  });
});
