import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the format module to avoid ANSI noise
vi.mock('../format.js', async () => {
  const actual = await vi.importActual<typeof import('../format.js')>('../format.js');
  return {
    ...actual,
    // Keep real implementations — we just need the module to be importable
  };
});

import type { BotmemClient } from '../client.js';

// Helper to create a mock client
function createMockClient(): BotmemClient {
  return {
    searchMemories: vi.fn().mockResolvedValue({ items: [], fallback: false }),
    listMemories: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getMemory: vi.fn().mockResolvedValue({
      id: 'm1',
      text: 'test',
      sourceType: 'email',
      connectorType: 'gmail',
      eventTime: '2025-01-01',
      importance: null,
      factuality: null,
      embeddingStatus: 'done',
      entities: null,
    }),
    deleteMemory: vi.fn().mockResolvedValue({ ok: true }),
    getMemoryStats: vi.fn().mockResolvedValue({
      total: 100,
      bySource: {},
      byConnector: {},
      byFactuality: {},
    }),
    listContacts: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    searchContacts: vi.fn().mockResolvedValue([]),
    getContact: vi.fn().mockResolvedValue({
      id: 'c1',
      displayName: 'Test',
      identifiers: [],
    }),
    getContactMemories: vi.fn().mockResolvedValue([]),
    agentAsk: vi.fn().mockResolvedValue({ answer: 'test answer' }),
    agentSummarize: vi.fn().mockResolvedValue({ summary: 'test summary' }),
    agentContext: vi.fn().mockResolvedValue({ contact: { displayName: 'Test' } }),
    listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    triggerSync: vi.fn().mockResolvedValue({ job: { id: 'j1' } }),
    retryFailedJobs: vi.fn().mockResolvedValue({ ok: true, retried: 2 }),
    retryFailedMemories: vi.fn().mockResolvedValue({ enqueued: 3, total: 5 }),
    listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    getVersion: vi.fn().mockResolvedValue({
      buildTime: '2025-01-01',
      gitHash: 'abc',
      uptime: 3600,
    }),
    getTimeline: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getRelated: vi.fn().mockResolvedValue({ items: [], source: null }),
    searchEntities: vi.fn().mockResolvedValue({ entities: [], total: 0 }),
    getEntityGraph: vi.fn().mockResolvedValue({
      entity: 'Test',
      memories: [],
      relatedEntities: [],
      contacts: [],
      memoryCount: 0,
    }),
    listMemoryBanks: vi.fn().mockResolvedValue([]),
    createMemoryBank: vi.fn().mockResolvedValue({ id: 'b1', name: 'Work' }),
    renameMemoryBank: vi.fn().mockResolvedValue({ id: 'b1', name: 'Personal' }),
    deleteMemoryBank: vi.fn().mockResolvedValue(undefined),
  } as unknown as BotmemClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let logSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let errorSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

/** Helper to extract a logged string from spy calls (avoids `unknown` type errors). */
function logged(spy: ReturnType<typeof vi.spyOn>, call = 0, arg = 0): string {
  return spy.mock.calls[call][arg] as string;
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

// --- Search ---
describe('runSearch', () => {
  let runSearch: typeof import('../commands/search.js').runSearch;

  beforeEach(async () => {
    ({ runSearch } = await import('../commands/search.js'));
  });

  it('should search with query words', async () => {
    const client = createMockClient();
    await runSearch(client, ['hello', 'world'], false);
    expect(client.searchMemories).toHaveBeenCalledWith(
      'hello world',
      undefined,
      undefined,
      undefined,
    );
    expect(logSpy).toHaveBeenCalled();
  });

  it('should pass filters and limit', async () => {
    const client = createMockClient();
    await runSearch(
      client,
      [
        'test',
        '--source',
        'email',
        '--connector',
        'gmail',
        '--limit',
        '5',
        '--memory-bank',
        'bank-1',
      ],
      false,
    );
    expect(client.searchMemories).toHaveBeenCalledWith(
      'test',
      { sourceType: 'email', connectorType: 'gmail' },
      5,
      'bank-1',
    );
  });

  it('should output JSON when json=true', async () => {
    const client = createMockClient();
    await runSearch(client, ['test'], true);
    const output = logged(logSpy, 0, 0);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('should exit when no query provided', async () => {
    const client = createMockClient();
    await runSearch(client, [], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a query'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should display resolved entities info when present', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 'm1',
          text: 'test',
          sourceType: 'email',
          connectorType: 'gmail',
          eventTime: '2025-01-01',
          score: 0.9,
        },
      ],
      fallback: false,
      resolvedEntities: {
        contacts: [{ id: 'c1', displayName: 'Amr' }],
        topicWords: ['project'],
      },
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Amr'));
  });

  it('should show no memories message when resolved entities but no results', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      fallback: false,
      resolvedEntities: {
        contacts: [{ id: 'c1', displayName: 'Amr' }],
        topicWords: [],
      },
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memories found'));
  });

  it('should show fallback message when fallback=true', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 'm1',
          text: 'test',
          sourceType: 'email',
          connectorType: 'gmail',
          eventTime: '2025-01-01',
          score: 0.9,
        },
      ],
      fallback: true,
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('semantically similar'));
  });

  it('should show temporal range when parsed.temporal is present', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 'm1',
          text: 'test',
          sourceType: 'email',
          connectorType: 'gmail',
          eventTime: '2025-01-01',
          score: 0.9,
        },
      ],
      fallback: false,
      parsed: { temporal: { from: '2025-01-01', to: '2025-01-31' }, temporalFallback: false },
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Date filter'));
  });

  it('should show temporal fallback message', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      fallback: false,
      parsed: { temporal: { from: '2025-01-01', to: '2025-01-31' }, temporalFallback: true },
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No results for that time range'));
  });

  it('should show intent when not recall', async () => {
    const client = createMockClient();
    (client.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      fallback: false,
      parsed: { intent: 'summarize' },
    });
    await runSearch(client, ['test'], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Intent: summarize'));
  });

  it('should pass --contact filter', async () => {
    const client = createMockClient();
    await runSearch(client, ['test', '--contact', 'c1'], false);
    expect(client.searchMemories).toHaveBeenCalledWith(
      'test',
      { contactId: 'c1' },
      undefined,
      undefined,
    );
  });
});

// --- Memories ---
describe('runMemories', () => {
  let runMemories: typeof import('../commands/memories.js').runMemories;
  let runMemory: typeof import('../commands/memories.js').runMemory;
  let runStats: typeof import('../commands/memories.js').runStats;

  beforeEach(async () => {
    ({ runMemories, runMemory, runStats } = await import('../commands/memories.js'));
  });

  it('should list memories with params', async () => {
    const client = createMockClient();
    await runMemories(
      client,
      ['--limit', '10', '--offset', '5', '--source', 'email', '--connector', 'gmail'],
      false,
    );
    expect(client.listMemories).toHaveBeenCalledWith({
      limit: 10,
      offset: 5,
      sourceType: 'email',
      connectorType: 'gmail',
    });
  });

  it('should output JSON when json=true', async () => {
    const client = createMockClient();
    await runMemories(client, [], true);
    const output = logged(logSpy, 0, 0);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  describe('runMemory', () => {
    it('should get a single memory', async () => {
      const client = createMockClient();
      await runMemory(client, ['m1'], false);
      expect(client.getMemory).toHaveBeenCalledWith('m1');
    });

    it('should delete a memory', async () => {
      const client = createMockClient();
      await runMemory(client, ['m1', 'delete'], false);
      expect(client.deleteMemory).toHaveBeenCalledWith('m1');
      expect(logSpy).toHaveBeenCalledWith('Memory deleted.');
    });

    it('should output JSON for delete', async () => {
      const client = createMockClient();
      await runMemory(client, ['m1', 'delete'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });

    it('should error when no ID provided', async () => {
      const client = createMockClient();
      await runMemory(client, [], false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an ID'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('runStats', () => {
    it('should get memory stats', async () => {
      const client = createMockClient();
      await runStats(client, false);
      expect(client.getMemoryStats).toHaveBeenCalled();
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runStats(client, true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });
  });
});

// --- Contacts ---
describe('runContacts', () => {
  let runContacts: typeof import('../commands/contacts.js').runContacts;
  let runContact: typeof import('../commands/contacts.js').runContact;

  beforeEach(async () => {
    ({ runContacts, runContact } = await import('../commands/contacts.js'));
  });

  it('should list contacts', async () => {
    const client = createMockClient();
    await runContacts(client, ['--limit', '20', '--offset', '10'], false);
    expect(client.listContacts).toHaveBeenCalledWith({ limit: 20, offset: 10 });
  });

  it('should search contacts', async () => {
    const client = createMockClient();
    await runContacts(client, ['search', 'Amr'], false);
    expect(client.searchContacts).toHaveBeenCalledWith('Amr');
  });

  it('should output JSON for list', async () => {
    const client = createMockClient();
    await runContacts(client, [], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should error on empty search query', async () => {
    const client = createMockClient();
    await runContacts(client, ['search'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a query'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('runContact', () => {
    it('should get contact details', async () => {
      const client = createMockClient();
      await runContact(client, ['c1'], false);
      expect(client.getContact).toHaveBeenCalledWith('c1');
    });

    it('should get contact memories', async () => {
      const client = createMockClient();
      await runContact(client, ['c1', 'memories'], false);
      expect(client.getContactMemories).toHaveBeenCalledWith('c1');
    });

    it('should error when no ID', async () => {
      const client = createMockClient();
      await runContact(client, [], false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an ID'));
    });

    it('should output JSON for contact', async () => {
      const client = createMockClient();
      await runContact(client, ['c1'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });

    it('should output JSON for contact memories', async () => {
      const client = createMockClient();
      await runContact(client, ['c1', 'memories'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });
  });
});

// --- Agent ---
describe('runAsk', () => {
  let runAsk: typeof import('../commands/agent.js').runAsk;
  let runContext: typeof import('../commands/agent.js').runContext;

  beforeEach(async () => {
    ({ runAsk, runContext } = await import('../commands/agent.js'));
  });

  it('should ask with query', async () => {
    const client = createMockClient();
    await runAsk(client, ['what', 'happened?'], false);
    expect(client.agentAsk).toHaveBeenCalledWith('what happened?', undefined, undefined);
  });

  it('should use summarize when --summarize flag', async () => {
    const client = createMockClient();
    await runAsk(client, ['my', 'week', '--summarize'], false);
    expect(client.agentSummarize).toHaveBeenCalledWith('my week', undefined);
  });

  it('should pass filters and limit', async () => {
    const client = createMockClient();
    await runAsk(
      client,
      [
        'test',
        '--source',
        'email',
        '--connector',
        'gmail',
        '--limit',
        '5',
        '--memory-bank',
        'bank-1',
      ],
      false,
    );
    expect(client.agentAsk).toHaveBeenCalledWith(
      'test',
      { sourceType: 'email', connectorType: 'gmail', memoryBankId: 'bank-1' },
      5,
    );
  });

  it('should output JSON', async () => {
    const client = createMockClient();
    await runAsk(client, ['test'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should error when no query', async () => {
    const client = createMockClient();
    await runAsk(client, [], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a query'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('runContext', () => {
    it('should get context for contact', async () => {
      const client = createMockClient();
      await runContext(client, ['c1'], false);
      expect(client.agentContext).toHaveBeenCalledWith('c1');
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runContext(client, ['c1'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });

    it('should error when no contact ID', async () => {
      const client = createMockClient();
      await runContext(client, [], false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a contact ID'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// --- Jobs ---
describe('runJobs', () => {
  let runJobs: typeof import('../commands/jobs.js').runJobs;
  let runSync: typeof import('../commands/jobs.js').runSync;
  let runRetry: typeof import('../commands/jobs.js').runRetry;
  let runAccounts: typeof import('../commands/jobs.js').runAccounts;

  beforeEach(async () => {
    ({ runJobs, runSync, runRetry, runAccounts } = await import('../commands/jobs.js'));
  });

  it('should list jobs', async () => {
    const client = createMockClient();
    await runJobs(client, [], false);
    expect(client.listJobs).toHaveBeenCalledWith(undefined);
  });

  it('should list jobs with account filter', async () => {
    const client = createMockClient();
    await runJobs(client, ['--account', 'acc-1'], false);
    expect(client.listJobs).toHaveBeenCalledWith('acc-1');
  });

  it('should output JSON', async () => {
    const client = createMockClient();
    await runJobs(client, [], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  describe('runSync', () => {
    it('should trigger sync', async () => {
      const client = createMockClient();
      await runSync(client, ['acc-1'], false);
      expect(client.triggerSync).toHaveBeenCalledWith('acc-1');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('j1'));
    });

    it('should error when no account ID', async () => {
      const client = createMockClient();
      await runSync(client, [], false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an account ID'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runSync(client, ['acc-1'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });
  });

  describe('runRetry', () => {
    it('should retry failed jobs and memories', async () => {
      const client = createMockClient();
      await runRetry(client, false);
      expect(client.retryFailedJobs).toHaveBeenCalled();
      expect(client.retryFailedMemories).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('3'));
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runRetry(client, true);
      const output = JSON.parse(logged(logSpy, 0, 0));
      expect(output.jobs.retried).toBe(2);
      expect(output.memories.enqueued).toBe(3);
    });
  });

  describe('runAccounts', () => {
    it('should list accounts', async () => {
      const client = createMockClient();
      await runAccounts(client, false);
      expect(client.listAccounts).toHaveBeenCalled();
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runAccounts(client, true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });
  });
});

// --- Timeline ---
describe('runTimeline', () => {
  let runTimeline: typeof import('../commands/timeline.js').runTimeline;

  beforeEach(async () => {
    ({ runTimeline } = await import('../commands/timeline.js'));
  });

  it('should get timeline with params', async () => {
    const client = createMockClient();
    await runTimeline(
      client,
      [
        '--from',
        '2025-01-01',
        '--to',
        '2025-01-31',
        '--query',
        'meeting',
        '--connector',
        'gmail',
        '--source',
        'email',
        '--limit',
        '10',
      ],
      false,
    );
    expect(client.getTimeline).toHaveBeenCalledWith({
      from: '2025-01-01',
      to: '2025-01-31',
      query: 'meeting',
      connectorType: 'gmail',
      sourceType: 'email',
      limit: 10,
    });
  });

  it('should output JSON', async () => {
    const client = createMockClient();
    await runTimeline(client, [], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should show "no memories" message when empty', async () => {
    const client = createMockClient();
    await runTimeline(client, [], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memories'));
  });

  it('should display timeline items grouped by date', async () => {
    const client = createMockClient();
    (client.getTimeline as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: 'm1',
          text: 'Meeting at 10am',
          sourceType: 'email',
          connectorType: 'gmail',
          eventTime: '2025-06-15T10:00:00Z',
        },
        {
          id: 'm2',
          text: 'Lunch plans',
          sourceType: 'message',
          connectorType: 'slack',
          eventTime: '2025-06-15T12:00:00Z',
        },
      ],
      total: 2,
    });
    await runTimeline(client, [], false);
    // Should contain date headers and items
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Meeting at 10am'));
  });
});

// --- Entities ---
describe('runEntities', () => {
  let runEntities: typeof import('../commands/entities.js').runEntities;
  let runRelated: typeof import('../commands/entities.js').runRelated;

  beforeEach(async () => {
    ({ runEntities, runRelated } = await import('../commands/entities.js'));
  });

  it('should show help when no subcommand', async () => {
    const client = createMockClient();
    await runEntities(client, [], false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('entities'));
  });

  it('should search entities', async () => {
    const client = createMockClient();
    (client.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue({
      entities: [{ value: 'Google', type: 'organization', memoryCount: 10, connectors: ['gmail'] }],
      total: 1,
    });
    await runEntities(
      client,
      ['search', 'Google', '--limit', '5', '--type', 'organization'],
      false,
    );
    expect(client.searchEntities).toHaveBeenCalledWith('Google', 5, 'organization');
  });

  it('should output JSON for search', async () => {
    const client = createMockClient();
    await runEntities(client, ['search', 'test'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should error when search has no query', async () => {
    const client = createMockClient();
    await runEntities(client, ['search'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a query'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should show entity graph', async () => {
    const client = createMockClient();
    (client.getEntityGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      entity: 'Google',
      memories: [
        {
          id: 'm1',
          text: 'Google meeting',
          sourceType: 'email',
          connectorType: 'gmail',
          eventTime: '2025-01-01',
        },
      ],
      relatedEntities: [{ value: 'AWS', type: 'organization', count: 5 }],
      contacts: [{ id: 'c1', displayName: 'Test User' }],
      memoryCount: 10,
    });
    await runEntities(client, ['graph', 'Google'], false);
    expect(client.getEntityGraph).toHaveBeenCalledWith('Google', undefined);
  });

  it('should output JSON for graph', async () => {
    const client = createMockClient();
    await runEntities(client, ['graph', 'Google'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should error on unknown subcommand', async () => {
    const client = createMockClient();
    await runEntities(client, ['unknown'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('runRelated', () => {
    it('should get related memories', async () => {
      const client = createMockClient();
      (client.getRelated as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [
          {
            id: 'm2',
            text: 'Related memory',
            sourceType: 'email',
            connectorType: 'gmail',
            eventTime: '2025-01-01',
            score: 0.9,
            relationship: 'similar',
          },
        ],
        source: { text: 'Source memory' },
      });
      await runRelated(client, ['m1', '--limit', '5'], false);
      expect(client.getRelated).toHaveBeenCalledWith('m1', 5);
    });

    it('should output JSON', async () => {
      const client = createMockClient();
      await runRelated(client, ['m1'], true);
      expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
    });

    it('should error when no memory ID', async () => {
      const client = createMockClient();
      await runRelated(client, [], false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a memory ID'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should show empty message when no related found', async () => {
      const client = createMockClient();
      await runRelated(client, ['m1'], false);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No related'));
    });
  });
});

// --- Memory Banks ---
describe('runMemoryBanks', () => {
  let runMemoryBanks: typeof import('../commands/memory-banks.js').runMemoryBanks;

  beforeEach(async () => {
    ({ runMemoryBanks } = await import('../commands/memory-banks.js'));
  });

  it('should list memory banks', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, [], false);
    expect(client.listMemoryBanks).toHaveBeenCalled();
  });

  it('should create a memory bank', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['create', 'Work'], false);
    expect(client.createMemoryBank).toHaveBeenCalledWith('Work');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Work'));
  });

  it('should rename a memory bank', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['rename', 'b1', 'Personal'], false);
    expect(client.renameMemoryBank).toHaveBeenCalledWith('b1', 'Personal');
  });

  it('should delete a memory bank', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['delete', 'b1'], false);
    expect(client.deleteMemoryBank).toHaveBeenCalledWith('b1');
  });

  it('should output JSON for list', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, [], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should output JSON for create', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['create', 'Work'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should output JSON for rename', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['rename', 'b1', 'New'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should output JSON for delete', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['delete', 'b1'], true);
    expect(() => JSON.parse(logged(logSpy, 0, 0))).not.toThrow();
  });

  it('should error when create has no name', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['create'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a name'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should error when rename missing args', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['rename', 'b1'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rename requires'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should error when delete has no id', async () => {
    const client = createMockClient();
    await runMemoryBanks(client, ['delete'], false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an id'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// --- Install Skill ---
describe('runInstallSkill', () => {
  let runInstallSkill: typeof import('../commands/install-skill.js').runInstallSkill;

  beforeEach(async () => {
    ({ runInstallSkill } = await import('../commands/install-skill.js'));
  });

  it('should create skill files in .agents and .claude directories', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    // Use a temp dir as cwd
    const tempDir = path.join(os.tmpdir(), `botmem-skill-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(tempDir);

    try {
      runInstallSkill();

      // Check .agents skill file was created
      const agentsSkill = path.join(tempDir, '.agents', 'skills', 'botmem-cli', 'SKILL.md');
      expect(fs.existsSync(agentsSkill)).toBe(true);
      const content = fs.readFileSync(agentsSkill, 'utf-8');
      expect(content).toContain('botmem-cli');

      // Check .claude symlink was created
      const claudeSkill = path.join(tempDir, '.claude', 'skills', 'botmem-cli', 'SKILL.md');
      expect(fs.existsSync(claudeSkill)).toBe(true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle running twice (existing symlink)', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tempDir = path.join(os.tmpdir(), `botmem-skill-test2-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(tempDir);

    try {
      runInstallSkill();
      // Run again — should not throw
      runInstallSkill();

      const claudeSkill = path.join(tempDir, '.claude', 'skills', 'botmem-cli', 'SKILL.md');
      expect(fs.existsSync(claudeSkill)).toBe(true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// --- Version ---
describe('runVersion', () => {
  let runVersion: typeof import('../commands/version.js').runVersion;

  beforeEach(async () => {
    ({ runVersion } = await import('../commands/version.js'));
  });

  it('should get and display version info', async () => {
    const client = createMockClient();
    await runVersion(client, false);
    expect(client.getVersion).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it('should output JSON', async () => {
    const client = createMockClient();
    await runVersion(client, true);
    const output = JSON.parse(logged(logSpy, 0, 0));
    expect(output.buildTime).toBe('2025-01-01');
    expect(output.gitHash).toBe('abc');
    expect(output.uptime).toBe(3600);
  });
});
