import { describe, it, expect, vi } from 'vitest';
import { TestHarness } from '../testing.js';
import { BaseConnector } from '../base.js';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '../types.js';

class HarnessTestConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'harness-test',
    name: 'Harness Test',
    description: 'Connector for testing the harness',
    color: '#000',
    icon: 'test',
    authType: 'api-key',
    configSchema: {},
  };

  authResult: AuthInitResult = { type: 'complete', auth: { accessToken: 'tok' } };
  syncFn: ((ctx: SyncContext) => Promise<SyncResult>) | null = null;

  async initiateAuth(): Promise<AuthInitResult> {
    return this.authResult;
  }

  async completeAuth(): Promise<AuthContext> { return {}; }
  async validateAuth(): Promise<boolean> { return true; }
  async revokeAuth(): Promise<void> {}

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (this.syncFn) return this.syncFn(ctx);
    return { cursor: null, hasMore: false, processed: 0 };
  }
}

describe('TestHarness', () => {
  describe('testAuth', () => {
    it('returns auth context on complete type', async () => {
      const connector = new HarnessTestConnector();
      const harness = new TestHarness(connector);
      const auth = await harness.testAuth({});
      expect(auth.accessToken).toBe('tok');
    });

    it('throws on redirect type', async () => {
      const connector = new HarnessTestConnector();
      connector.authResult = { type: 'redirect', url: 'https://example.com' };
      const harness = new TestHarness(connector);
      await expect(harness.testAuth({})).rejects.toThrow('cannot auto-complete');
    });

    it('throws on qr-code type', async () => {
      const connector = new HarnessTestConnector();
      connector.authResult = { type: 'qr-code', qrData: 'data', wsChannel: 'ch' };
      const harness = new TestHarness(connector);
      await expect(harness.testAuth({})).rejects.toThrow('cannot auto-complete');
    });
  });

  describe('testSync', () => {
    it('collects data events', async () => {
      const connector = new HarnessTestConnector();
      connector.syncFn = async (ctx) => {
        connector.emitData({
          sourceType: 'message',
          sourceId: 'm1',
          timestamp: '2026-01-01T00:00:00Z',
          content: { text: 'hello', metadata: {} },
        });
        connector.emitData({
          sourceType: 'email',
          sourceId: 'e1',
          timestamp: '2026-01-01T00:00:00Z',
          content: { text: 'email', metadata: {} },
        });
        return { cursor: 'c1', hasMore: true, processed: 2 };
      };

      const harness = new TestHarness(connector);
      const result = await harness.testSync({ accessToken: 'tok' });
      expect(result.events).toHaveLength(2);
      expect(result.events[0].sourceId).toBe('m1');
      expect(result.events[1].sourceType).toBe('email');
    });

    it('collects log events from logger', async () => {
      const connector = new HarnessTestConnector();
      connector.syncFn = async (ctx) => {
        ctx.logger.info('starting sync');
        ctx.logger.warn('slow response');
        ctx.logger.error('failed item');
        ctx.logger.debug('detail');
        return { cursor: null, hasMore: false, processed: 0 };
      };

      const harness = new TestHarness(connector);
      const result = await harness.testSync({ accessToken: 'tok' });
      expect(result.logs).toHaveLength(4);
      expect(result.logs[0]).toEqual({ level: 'info', message: 'starting sync' });
      expect(result.logs[1]).toEqual({ level: 'warn', message: 'slow response' });
      expect(result.logs[2]).toEqual({ level: 'error', message: 'failed item' });
      expect(result.logs[3]).toEqual({ level: 'debug', message: 'detail' });
    });

    it('resets events between calls', async () => {
      const connector = new HarnessTestConnector();
      let callCount = 0;
      connector.syncFn = async () => {
        callCount++;
        connector.emitData({
          sourceType: 'message',
          sourceId: `m${callCount}`,
          timestamp: '2026-01-01T00:00:00Z',
          content: { text: `call ${callCount}`, metadata: {} },
        });
        return { cursor: null, hasMore: false, processed: 1 };
      };

      const harness = new TestHarness(connector);
      const r1 = await harness.testSync({ accessToken: 'tok' });
      expect(r1.events).toHaveLength(1);

      const r2 = await harness.testSync({ accessToken: 'tok' });
      expect(r2.events).toHaveLength(1);
      expect(r2.events[0].sourceId).toBe('m2');
    });

    it('passes cursor to sync context', async () => {
      const connector = new HarnessTestConnector();
      let receivedCursor: string | null = null;
      connector.syncFn = async (ctx) => {
        receivedCursor = ctx.cursor;
        return { cursor: null, hasMore: false, processed: 0 };
      };

      const harness = new TestHarness(connector);
      await harness.testSync({ accessToken: 'tok' }, 'page-2');
      expect(receivedCursor).toBe('page-2');
    });

    it('provides a valid sync context', async () => {
      const connector = new HarnessTestConnector();
      let ctx: SyncContext | null = null;
      connector.syncFn = async (c) => {
        ctx = c;
        return { cursor: null, hasMore: false, processed: 0 };
      };

      const harness = new TestHarness(connector);
      await harness.testSync({ accessToken: 'tok' });

      expect(ctx!.accountId).toBe('test-account');
      expect(ctx!.jobId).toBe('test-job');
      expect(ctx!.auth.accessToken).toBe('tok');
      expect(ctx!.signal).toBeDefined();
      expect(ctx!.logger).toBeDefined();
    });
  });
});
