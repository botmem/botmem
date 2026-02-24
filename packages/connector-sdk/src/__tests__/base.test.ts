import { describe, it, expect, vi } from 'vitest';
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
