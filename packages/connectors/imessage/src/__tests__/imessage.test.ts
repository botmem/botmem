import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IMessageConnector } from '../index.js';

vi.mock('../exporter.js', () => ({
  checkExporter: vi.fn().mockResolvedValue(true),
  exportMessages: vi.fn().mockResolvedValue(10),
}));

describe('IMessageConnector', () => {
  let connector: IMessageConnector;

  beforeEach(() => {
    connector = new IMessageConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('imessage');
    });

    it('has local-tool auth type', () => {
      expect(connector.manifest.authType).toBe('local-tool');
    });
  });

  describe('initiateAuth', () => {
    it('returns complete when exporter available', async () => {
      const result = await connector.initiateAuth({});
      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.raw?.tool).toBe('imessage-exporter');
      }
    });

    it('throws when exporter not available', async () => {
      const { checkExporter } = await import('../exporter.js');
      (checkExporter as any).mockResolvedValue(false);
      await expect(connector.initiateAuth({})).rejects.toThrow('imessage-exporter not found');
    });
  });

  describe('completeAuth', () => {
    it('returns auth context', async () => {
      const auth = await connector.completeAuth({});
      expect(auth.raw?.tool).toBe('imessage-exporter');
    });
  });

  describe('validateAuth', () => {
    it('checks exporter availability', async () => {
      const { checkExporter } = await import('../exporter.js');
      (checkExporter as any).mockResolvedValue(true);
      const result = await connector.validateAuth({});
      expect(result).toBe(true);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      await expect(connector.revokeAuth()).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('exports messages and returns result', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { raw: { tool: 'imessage-exporter' } },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(10);
      expect(result.hasMore).toBe(false);
      expect(progressListener).toHaveBeenCalledWith({ processed: 10 });
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(IMessageConnector);
  });
});
