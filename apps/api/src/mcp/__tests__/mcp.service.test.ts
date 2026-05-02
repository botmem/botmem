import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { getAgentCommand } from '@botmem/shared';
import { McpService } from '../mcp.service';
import type { MemoryService } from '../../memory/memory.service';
import type { AgentService } from '../../agent/agent.service';
import type { DbService } from '../../db/db.service';
import type { AccountsService } from '../../accounts/accounts.service';
import type { ConnectorsService } from '../../connectors/connectors.service';
import type { Queue } from 'bullmq';

function createQueue() {
  return {
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
    }),
  };
}

function createService() {
  const memoryService = {
    needsRecoveryKey: vi.fn().mockResolvedValue(false),
    search: vi.fn().mockResolvedValue({ items: [], fallback: false }),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    timeline: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getById: vi.fn().mockResolvedValue(null),
    getStats: vi.fn().mockResolvedValue({
      total: 1,
      bySource: { email: 1 },
      byConnector: { gmail: 1 },
      byFactuality: { FACT: 1 },
    }),
  } as unknown as MemoryService;
  const agentService = {
    ask: vi.fn().mockResolvedValue({ results: [], query: 'q' }),
  } as unknown as AgentService;
  const dbService = {
    withUserId: vi.fn().mockImplementation((_userId: string, fn: () => unknown) => fn()),
  } as unknown as DbService;
  const accountsService = {
    getAll: vi.fn().mockResolvedValue([
      {
        id: 'account-1',
        connectorType: 'gmail',
        identifier: 'user@example.com',
        status: 'connected',
        schedule: 'manual',
        tunnelMode: true,
        lastSyncAt: new Date('2026-05-01T00:00:00.000Z'),
        itemsSynced: 12,
        lastError: null,
        updatedAt: new Date('2026-05-01T01:00:00.000Z'),
      },
    ]),
  } as unknown as AccountsService;
  const connectorsService = {
    list: vi.fn().mockReturnValue([
      {
        id: 'gmail',
        name: 'Gmail',
        authType: 'oauth2',
        version: '1.0.0',
        trustScore: 0.9,
      },
    ]),
  } as unknown as ConnectorsService;
  const queues = createQueueTuple();
  const service = new McpService(
    memoryService,
    agentService,
    dbService,
    accountsService,
    connectorsService,
    ...queues,
  );
  return { service, memoryService, agentService, accountsService, connectorsService, queues };
}

function createQueueTuple(): [Queue, Queue, Queue, Queue, Queue] {
  return [createQueue(), createQueue(), createQueue(), createQueue(), createQueue()] as unknown as [
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
  ];
}

function getTool(server: unknown, name: string) {
  return (server as { _registeredTools: Record<string, { handler: (params: unknown) => unknown }> })
    ._registeredTools[name];
}

describe('McpService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it('uses shared registry metadata for MCP tool descriptions and schemas', () => {
    const { service } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const tools = (server as { _registeredTools: Record<string, { description: string }> })
      ._registeredTools;

    expect(tools.search.description).toBe(getAgentCommand('search')?.mcp?.description);
    expect(tools.ask.description).toBe(getAgentCommand('ask')?.mcp?.description);
    expect(tools.status.description).toBe(getAgentCommand('status')?.mcp?.description);
    expect(tools.sources.description).toBe(getAgentCommand('sources')?.mcp?.description);
    expect(tools.list.description).toBe(getAgentCommand('memories')?.mcp?.description);
    expect(tools.timeline.description).toBe(getAgentCommand('timeline')?.mcp?.description);
    expect(tools.get_memory.description).toBe(getAgentCommand('memory')?.mcp?.description);

    service.onModuleDestroy();
  });

  it('returns connector-agnostic status without memory text', async () => {
    const { service, accountsService, connectorsService, queues } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const status = getTool(server, 'status');

    const response = await status.handler({});
    const parsed = JSON.parse(
      (response as { content: Array<{ text: string }> }).content[0].text,
    ) as Record<string, unknown>;

    expect(accountsService.getAll).toHaveBeenCalledWith('user-1');
    expect(connectorsService.list).toHaveBeenCalled();
    expect(queues[0].getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    expect(parsed).toMatchObject({
      memory: { total: 1 },
      lastUpdate: '2026-05-01T01:00:00.000Z',
    });

    service.onModuleDestroy();
  });

  it('starts SSE streams with an initial heartbeat comment', () => {
    vi.useFakeTimers();
    const { service } = createService();
    const req = new EventEmitter() as EventEmitter & { method: string; originalUrl: string };
    req.method = 'GET';
    req.originalUrl = '/mcp/';
    const res = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      writableEnded: false,
    };

    service.handleSseStream(req as never, res as never, 'user-1', 'client-1');

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(': botmem-ready\n\n');

    vi.advanceTimersByTime(25_000);
    expect(res.write).toHaveBeenCalledWith(': keepalive\n\n');

    req.emit('close');
    service.onModuleDestroy();
  });

  it('passes sort and filters to the list tool', async () => {
    const { service, memoryService } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const list = getTool(server, 'list');

    await list.handler({
      source_type: 'location',
      connector_type: 'locations',
      sort_by: 'eventTime',
      limit: 1,
      offset: 2,
    });

    expect(memoryService.list).toHaveBeenCalledWith({
      connectorType: 'locations',
      sourceType: 'location',
      limit: 1,
      offset: 2,
      sortBy: 'eventTime',
      userId: 'user-1',
    });

    service.onModuleDestroy();
  });

  it('returns a structured error when get_memory cannot find the id', async () => {
    const { service } = createService();
    const server = (
      service as unknown as { createServer: (userId: string) => unknown }
    ).createServer('user-1');
    const getMemory = getTool(server, 'get_memory');

    const response = await getMemory.handler({ id: 'missing' });

    expect(response).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: Memory not found: missing' }],
    });

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

  it('serializes dates and backfills photo takenAt in MCP output', () => {
    const { service } = createService();
    const output = (
      service as unknown as {
        formatMcpResponse: (data: unknown, textMaxLength?: number) => string;
      }
    ).formatMcpResponse({
      items: [
        {
          id: 'photo-1',
          connectorType: 'photos',
          sourceType: 'photo',
          text: 'Photo: IMG_0001.jpg',
          eventTime: new Date('2026-04-30T10:15:00.000Z'),
          metadata: JSON.stringify({ fileName: 'IMG_0001.jpg' }),
        },
      ],
    });
    const parsed = JSON.parse(output) as { items: Array<Record<string, unknown>> };

    expect(parsed.items[0].eventTime).toBe('2026-04-30T10:15:00.000Z');
    expect(parsed.items[0].metadata).toEqual({
      fileName: 'IMG_0001.jpg',
      takenAt: '2026-04-30T10:15:00.000Z',
    });

    service.onModuleDestroy();
  });
});
