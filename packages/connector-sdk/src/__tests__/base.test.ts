import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseConnector } from '../base.js';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult, ConnectorDataEvent, ProgressEvent } from '../types.js';

class MockConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'mock',
    name: 'Mock',
    description: 'A mock connector for testing',
    color: '#000000',
    icon: 'test',
    authType: 'api-key',
    configSchema: {},
    entities: ['person'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.7,
  };

  async initiateAuth(_config: Record<string, unknown>): Promise<AuthInitResult> {
    return { type: 'complete', auth: { accessToken: 'test-token' } };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    return { accessToken: params.token as string };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    return !!auth.accessToken;
  }

  async revokeAuth(_auth: AuthContext): Promise<void> {}

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    return { cursor: null, hasMore: false, processed: 0 };
  }
}

describe('BaseConnector', () => {
  it('creates instance with manifest', () => {
    const connector = new MockConnector();
    expect(connector.manifest.id).toBe('mock');
    expect(connector.manifest.name).toBe('Mock');
    expect(connector.manifest.authType).toBe('api-key');
  });

  it('initiateAuth returns auth result', async () => {
    const connector = new MockConnector();
    const result = await connector.initiateAuth({});
    expect(result.type).toBe('complete');
    if (result.type === 'complete') {
      expect(result.auth.accessToken).toBe('test-token');
    }
  });

  it('completeAuth returns auth context', async () => {
    const connector = new MockConnector();
    const auth = await connector.completeAuth({ token: 'abc' });
    expect(auth.accessToken).toBe('abc');
  });

  it('validateAuth checks token', async () => {
    const connector = new MockConnector();
    expect(await connector.validateAuth({ accessToken: 'valid' })).toBe(true);
    expect(await connector.validateAuth({})).toBe(false);
  });

  it('revokeAuth does not throw', async () => {
    const connector = new MockConnector();
    await expect(connector.revokeAuth({ accessToken: 'test' })).resolves.toBeUndefined();
  });

  it('sync returns result', async () => {
    const connector = new MockConnector();
    const ctx: SyncContext = {
      accountId: 'acc-1',
      auth: { accessToken: 'test' },
      cursor: null,
      jobId: 'job-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };
    const result = await connector.sync(ctx);
    expect(result.processed).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('emitData', () => {
  it('emits data event', () => {
    const connector = new MockConnector();
    const listener = vi.fn();
    connector.on('data', listener);

    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'msg-1',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'hello', metadata: {} },
    };

    connector.emitData(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('returns true when listener exists', () => {
    const connector = new MockConnector();
    connector.on('data', () => {});
    const result = connector.emitData({
      sourceType: 'email',
      sourceId: 'e-1',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: '', metadata: {} },
    });
    expect(result).toBe(true);
  });

  it('returns false when no listener', () => {
    const connector = new MockConnector();
    const result = connector.emitData({
      sourceType: 'email',
      sourceId: 'e-1',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: '', metadata: {} },
    });
    expect(result).toBe(false);
  });
});

describe('emitProgress', () => {
  it('emits progress event', () => {
    const connector = new MockConnector();
    const listener = vi.fn();
    connector.on('progress', listener);

    const event: ProgressEvent = { processed: 10, total: 100 };
    connector.emitProgress(event);
    expect(listener).toHaveBeenCalledWith(event);
  });
});

describe('log', () => {
  it('emits log event with level and message', () => {
    const connector = new MockConnector();
    const listener = vi.fn();
    connector.on('log', listener);

    // Access protected method via any
    (connector as any).log('info', 'test message');
    expect(listener).toHaveBeenCalledWith({ level: 'info', message: 'test message' });
  });

  it('emits log with different levels', () => {
    const connector = new MockConnector();
    const listener = vi.fn();
    connector.on('log', listener);

    (connector as any).log('warn', 'warning');
    (connector as any).log('error', 'failure');
    (connector as any).log('debug', 'debugging');

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledWith({ level: 'warn', message: 'warning' });
    expect(listener).toHaveBeenCalledWith({ level: 'error', message: 'failure' });
    expect(listener).toHaveBeenCalledWith({ level: 'debug', message: 'debugging' });
  });
});

describe('clean', () => {
  it('returns plain text as-is (collapsed whitespace)', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'hello   world', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    expect((result as any).text).toBe('hello world');
  });

  it('strips HTML tags and decodes entities', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'email',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: '<html><div>Hello &amp; &lt;world&gt; &quot;hi&quot; &#39;bye&#39;</div></html>', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    const text = (result as any).text;
    expect(text).toContain('Hello & <world>');
    expect(text).toContain('"hi"');
    expect(text).toContain("'bye'");
    expect(text).not.toContain('<div>');
  });

  it('strips style and script tags', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'email',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: '<html><style>body{color:red}</style><script>alert(1)</script><div>content</div></html>', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    const text = (result as any).text;
    expect(text).toContain('content');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
  });

  it('strips invisible Unicode characters', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'hello\u200Bworld\u00ADtest\uFEFFend', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    expect((result as any).text).toBe('helloworldtestend');
  });

  it('strips tracking URLs', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'email',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'Click here https://example.com/ls/click?upn=abc123 for more', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    expect((result as any).text).not.toContain('upn=');
  });

  it('handles empty text', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    expect((result as any).text).toBe('');
  });

  it('strips &nbsp;', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'email',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: '<html><div>hello&nbsp;world</div></html>', metadata: {} },
    };
    const result = connector.clean(event, {} as any);
    expect((result as any).text).toContain('hello world');
  });
});

describe('embed (default)', () => {
  it('returns cleaned text and participant entities', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'hello', participants: ['Alice', 'Bob'], metadata: {} },
    };
    const result = connector.embed(event, 'hello', {} as any);
    expect((result as any).text).toBe('hello');
    expect((result as any).entities).toHaveLength(2);
    expect((result as any).entities[0]).toEqual({ type: 'person', id: 'Alice', role: 'participant' });
  });

  it('returns empty entities when no participants', () => {
    const connector = new MockConnector();
    const event: ConnectorDataEvent = {
      sourceType: 'message',
      sourceId: 'x',
      timestamp: '2026-01-01T00:00:00Z',
      content: { text: 'hello', metadata: {} },
    };
    const result = connector.embed(event, 'hello', {} as any);
    expect((result as any).entities).toEqual([]);
  });
});

describe('enrich (default)', () => {
  it('returns empty object', () => {
    const connector = new MockConnector();
    const result = connector.enrich('mem-1', {} as any);
    expect(result).toEqual({});
  });
});

describe('extractFile (default)', () => {
  it('returns null', async () => {
    const connector = new MockConnector();
    const result = await connector.extractFile('http://example.com/file', 'text/plain', {});
    expect(result).toBeNull();
  });
});

describe('wrapSyncContext', () => {
  let originalLimit: number;

  beforeEach(() => {
    originalLimit = BaseConnector.DEBUG_SYNC_LIMIT;
  });

  afterEach(() => {
    BaseConnector.DEBUG_SYNC_LIMIT = originalLimit;
  });

  it('returns ctx unchanged when DEBUG_SYNC_LIMIT <= 0', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 0;
    const connector = new MockConnector();
    const ctx: SyncContext = {
      accountId: 'acc-1',
      auth: { accessToken: 'test' },
      cursor: null,
      jobId: 'job-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };
    const result = connector.wrapSyncContext(ctx);
    expect(result).toBe(ctx);
  });

  it('returns wrapped ctx with new signal when limit > 0', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 10;
    const connector = new MockConnector();
    const ctx: SyncContext = {
      accountId: 'acc-1',
      auth: { accessToken: 'test' },
      cursor: null,
      jobId: 'job-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: AbortSignal.timeout(5000),
    };
    const result = connector.wrapSyncContext(ctx);
    expect(result).not.toBe(ctx);
    expect(result.signal).not.toBe(ctx.signal);
    expect(result.accountId).toBe('acc-1');
  });

  it('propagates parent abort to wrapped signal', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 10;
    const connector = new MockConnector();
    const ac = new AbortController();
    const ctx: SyncContext = {
      accountId: 'acc-1',
      auth: { accessToken: 'test' },
      cursor: null,
      jobId: 'job-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: ac.signal,
    };
    const result = connector.wrapSyncContext(ctx);
    expect(result.signal.aborted).toBe(false);
    ac.abort();
    expect(result.signal.aborted).toBe(true);
  });
});

describe('DEBUG_SYNC_LIMIT enforcement', () => {
  let originalLimit: number;

  beforeEach(() => {
    originalLimit = BaseConnector.DEBUG_SYNC_LIMIT;
  });

  afterEach(() => {
    BaseConnector.DEBUG_SYNC_LIMIT = originalLimit;
  });

  it('stops emitting after limit reached and aborts', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 2;
    const connector = new MockConnector();
    connector.wrapSyncContext({
      accountId: 'a', auth: {}, cursor: null, jobId: 'j',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: new AbortController().signal,
    });
    const listener = vi.fn();
    const logListener = vi.fn();
    connector.on('data', listener);
    connector.on('log', logListener);

    const event: ConnectorDataEvent = { sourceType: 'message', sourceId: 'x', timestamp: '2026-01-01T00:00:00Z', content: { text: 'a', metadata: {} } };
    expect(connector.emitData(event)).toBe(true);
    expect(connector.emitData(event)).toBe(true);
    expect(connector.isLimitReached).toBe(true);
    // Third emit should return false
    expect(connector.emitData(event)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isLimitReached returns false when limit is 0', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 0;
    const connector = new MockConnector();
    expect(connector.isLimitReached).toBe(false);
  });

  it('resetSyncLimit resets counter', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 1;
    const connector = new MockConnector();
    connector.on('data', () => {});
    const event: ConnectorDataEvent = { sourceType: 'message', sourceId: 'x', timestamp: '2026-01-01T00:00:00Z', content: { text: 'a', metadata: {} } };
    connector.emitData(event);
    expect(connector.isLimitReached).toBe(true);
    connector.resetSyncLimit();
    expect(connector.isLimitReached).toBe(false);
    expect(connector.emitData(event)).toBe(true);
  });
});

describe('index exports', () => {
  it('re-exports all expected symbols', async () => {
    const mod = await import('../index.js');
    expect(mod.BaseConnector).toBeDefined();
    expect(mod.ConnectorRegistry).toBeDefined();
    expect(mod.TestHarness).toBeDefined();
  });
});
