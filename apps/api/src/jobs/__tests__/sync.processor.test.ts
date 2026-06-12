/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi } from 'vitest';
import { SyncProcessor } from '../sync.processor';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AccountsService } from '../../accounts/accounts.service';
import { AuthService } from '../../auth/auth.service';
import { JobsService } from '../jobs.service';
import { LogsService } from '../../logs/logs.service';
import { EventsService } from '../../events/events.service';
import { DbService } from '../../db/db.service';
import { SettingsService } from '../../settings/settings.service';
import { ConfigService } from '../../config/config.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { EventEmitter } from 'events';
import { AppleTunnelService } from '../../apple-tunnel/apple-tunnel.service';
import { PeopleService } from '../../people/people.service';

function createMockDeps() {
  const createInsertChain = () => ({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'raw-1' }]),
      }),
    }),
  });

  const mockConnector = Object.assign(new EventEmitter(), {
    manifest: { id: 'gmail' },
    sync: vi.fn(),
    removeAllListeners: vi.fn(),
    resetSyncLimit: vi.fn(),
    wrapSyncContext: vi.fn((ctx: Record<string, unknown>) => ctx),
    isLimitReached: false,
  });

  const connectors = {
    get: vi.fn().mockReturnValue(mockConnector),
  } as unknown as ConnectorsService;

  const accountsService = {
    getById: vi.fn().mockResolvedValue({
      id: 'acc-1',
      connectorType: 'gmail',
      authContext: '{"accessToken":"tok"}',
      lastCursor: null,
      itemsSynced: 5,
    }),
    update: vi.fn().mockResolvedValue({}),
  } as unknown as AccountsService;

  const authService = {
    getSavedCredentials: vi.fn().mockResolvedValue(null),
  } as unknown as AuthService;

  const jobsService = {
    updateJob: vi.fn().mockResolvedValue(undefined),
    triggerSync: vi.fn().mockResolvedValue({}),
  } as unknown as JobsService;

  const logsService = {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as LogsService;

  const events = {
    emitToChannel: vi.fn(),
    emitDebounced: vi.fn(),
  } as unknown as EventsService;

  const dbService = {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-1' }]),
        }),
      }),
      insert: vi.fn().mockReturnValue(createInsertChain()),
    },
    withUserId: vi
      .fn()
      .mockImplementation(
        (_uid: string, fn: (db: Record<string, ReturnType<typeof vi.fn>>) => Promise<void>) =>
          fn({
            insert: vi.fn().mockReturnValue(createInsertChain()),
          }),
      ),
  } as unknown as DbService;

  const memoryQueue = {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('bullmq').Queue;

  const moduleRef = {
    get: vi.fn().mockReturnValue(null),
    resolve: vi.fn().mockResolvedValue(null),
  };

  const settingsService = {
    get: vi.fn().mockReturnValue(''),
    onChange: vi.fn(),
  } as unknown as SettingsService;

  const configService = {
    syncDebugLimit: 0,
  } as unknown as ConfigService;

  const analytics = {
    capture: vi.fn(),
  } as unknown as AnalyticsService;

  const traceContext = {
    current: vi.fn().mockReturnValue({ traceId: 'aaaa', spanId: 'bbbb' }),
    run: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
    set: vi.fn(),
  } as unknown as {
    current: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };

  const cryptoService = {
    encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : null)),
    decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
    hmac: vi.fn((v: string) => `hmac:${v}`),
  };

  return {
    connectors,
    accountsService,
    authService,
    jobsService,
    logsService,
    events,
    dbService,
    cryptoService,
    memoryQueue,
    settingsService,
    configService,
    analytics,
    traceContext,
    moduleRef,
    mockConnector,
  };
}

describe('SyncProcessor', () => {
  it('processes sync job successfully', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockResolvedValue({ cursor: 'c1', hasMore: false, processed: 10 });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;
    await processor.process(job);

    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'running' }),
    );
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ status: 'syncing' }),
    );
    // After loop, cursor is saved per page
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        lastCursor: 'c1',
        itemsSynced: 15,
      }),
    );
    // After loop completes, status is set to connected
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        status: 'connected',
      }),
    );
    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });

  it('uses emitted raw events as pipeline total when connector processed count is zero', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockImplementation(async () => {
      mockConnector.emit('data', {
        sourceType: 'contact',
        sourceId: 'wa-group:123@g.us',
        timestamp: new Date().toISOString(),
        content: { text: 'WhatsApp group: Test', metadata: { type: 'contact' } },
      });
      return { cursor: null, hasMore: false, processed: 0 };
    });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await processor.process({
      data: { accountId: 'acc-1', connectorType: 'whatsapp', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job);

    expect(memoryQueue.add).toHaveBeenCalledOnce();
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ itemsSynced: 6 }),
    );
    expect(jobsService.updateJob).toHaveBeenCalledWith('j1', { total: 1 });
    expect(jobsService.updateJob).not.toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'done', total: 0 }),
    );
  });

  it('fails sync when raw event enqueue fails after insert', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    (memoryQueue.add as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    mockConnector.sync.mockImplementation(async () => {
      mockConnector.emit('data', {
        sourceType: 'message',
        sourceId: 'msg-1',
        timestamp: new Date().toISOString(),
        content: { text: 'hello' },
      });
      return { cursor: null, hasMore: false, processed: 1 };
    });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await expect(
      processor.process({
        data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
        opts: { attempts: 1 },
        attemptsMade: 0,
      } as unknown as import('bullmq').Job),
    ).rejects.toThrow('redis unavailable');

    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'failed', error: 'redis unavailable' }),
    );
    expect(logsService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('Failed to persist/enqueue event msg-1'),
      }),
    );
  });

  it('passes known owner phone numbers to WhatsApp connector sync', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    vi.mocked(dbService.withUserId).mockImplementation(
      async (_uid: string, fn: (db: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi
                  .fn()
                  .mockResolvedValue([
                    { value: 'enc:+971 50 855 6252' },
                    { value: 'enc:+971508556252' },
                  ]),
              }),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'raw-1' }]),
              }),
            }),
          }),
        }),
    );
    mockConnector.sync.mockResolvedValue({ cursor: null, hasMore: false, processed: 0 });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await processor.process({
      data: { accountId: 'acc-1', connectorType: 'whatsapp', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job);

    expect(mockConnector.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        knownPhoneNumbers: ['+971508556252'],
      }),
    );
  });

  it('does not enqueue duplicate raw events', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    vi.mocked(dbService.withUserId).mockImplementation(
      async (_uid: string, fn: (db: Record<string, unknown>) => Promise<unknown>) => {
        await fn({
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              onConflictDoNothing: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        });
        return [];
      },
    );
    mockConnector.sync.mockImplementation(async () => {
      mockConnector.emit('data', {
        sourceType: 'message',
        sourceId: 'wa:chat:msg-1',
        timestamp: new Date().toISOString(),
        content: { text: 'duplicate', metadata: {} },
      });
      return { cursor: null, hasMore: false, processed: 1 };
    });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await processor.process({
      data: { accountId: 'acc-1', connectorType: 'whatsapp', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job);

    expect(memoryQueue.add).not.toHaveBeenCalled();
  });

  it('handles error during sync', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockRejectedValue(new Error('API rate limited'));

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    await expect(processor.process(job)).rejects.toThrow('API rate limited');

    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({
        status: 'failed',
        error: 'API rate limited',
      }),
    );
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(events.emitToChannel).toHaveBeenCalledWith('job:j1', 'job:complete', {
      jobId: 'j1',
      status: 'failed',
    });
    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });

  it('marks unrecoverable auth/session failures as reconnect_required', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockRejectedValue(
      new Error('WhatsApp session files missing — please reconnect (re-scan QR)'),
    );

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'whatsapp', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ status: 'reconnect_required' }),
    );
  });

  it('keeps transient WhatsApp connection loss recoverable', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockRejectedValue(
      new Error('WhatsApp session disconnected: Connection lost during sync'),
    );

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'whatsapp', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    await expect(processor.process(job)).rejects.toThrow('Connection lost during sync');

    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ status: 'connected', lastError: null }),
    );
    expect(events.emitToChannel).not.toHaveBeenCalledWith(
      'notifications',
      'connector:warning',
      expect.anything(),
    );
  });

  it('keeps successful syncs degraded when a connector emits a non-fatal warning', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockImplementation(async () => {
      mockConnector.emit('degraded', {
        message: 'Google Contacts credentials need reconnect, continuing Gmail email sync',
      });
      return { cursor: null, hasMore: false, processed: 0 };
    });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    await processor.process(job);

    expect(accountsService.update).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        status: 'degraded',
        lastError: 'Google Contacts credentials need reconnect, continuing Gmail email sync',
      }),
    );
  });

  it('iterates pages when hasMore is true', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    // First call returns hasMore:true, second returns hasMore:false
    mockConnector.sync
      .mockResolvedValueOnce({ cursor: 'c1', hasMore: true, processed: 50 })
      .mockResolvedValueOnce({ cursor: 'c2', hasMore: false, processed: 10 });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;
    await processor.process(job);

    // sync should have been called twice (two pages)
    expect(mockConnector.sync).toHaveBeenCalledTimes(2);
  });

  it('does not iterate when hasMore is false', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockResolvedValue({ cursor: null, hasMore: false, processed: 5 });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;
    await processor.process(job);

    expect(mockConnector.sync).toHaveBeenCalledTimes(1);
  });

  it('processes a job even when the account row was left in syncing state', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'acc-1',
      connectorType: 'gmail',
      status: 'syncing',
      authContext: '{"accessToken":"tok"}',
      lastCursor: null,
      itemsSynced: 5,
    } as never);
    mockConnector.sync.mockResolvedValue({ cursor: null, hasMore: false, processed: 0 });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    await processor.process(job);

    expect(mockConnector.sync).toHaveBeenCalledTimes(1);
    expect(jobsService.updateJob).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ status: 'done' }),
    );
  });

  it('creates logger that adds logs', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockImplementation(
      async (ctx: {
        logger: {
          info: (m: string) => void;
          warn: (m: string) => void;
          error: (m: string) => void;
          debug: (m: string) => void;
        };
      }) => {
        ctx.logger.info('started');
        ctx.logger.warn('slow');
        ctx.logger.error('oops');
        ctx.logger.debug('trace');
        return { cursor: null, hasMore: false, processed: 0 };
      },
    );

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;
    await processor.process(job);

    expect(logsService.add).toHaveBeenCalledTimes(4);
    expect(logsService.add).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: 'started' }),
    );
  });

  it('cleans up listeners in finally block', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    mockConnector.sync.mockRejectedValue(new Error('fail'));

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
    );
    const job = {
      data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job;

    try {
      await processor.process(job);
    } catch {
      /* empty */
    }

    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });

  it('injects WebSocket tunnel transport for iMessage tunnel accounts', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    const setTunnelTransport = vi.fn();
    Object.assign(mockConnector, { setTunnelTransport });
    mockConnector.sync.mockResolvedValue({ cursor: null, hasMore: false, processed: 0 });
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'apple-msg-1',
      connectorType: 'imessage',
      authContext: '{"raw":{"tunnelMode":true}}',
      lastCursor: null,
      itemsSynced: 0,
      tunnelMode: true,
    } as never);
    vi.mocked(moduleRef.get).mockReturnValue({ isConnected: vi.fn() } as never);

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await processor.process({
      data: { accountId: 'apple-msg-1', connectorType: 'imessage', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job);

    expect(moduleRef.get).toHaveBeenCalledWith(AppleTunnelService, { strict: false });
    expect(setTunnelTransport).toHaveBeenCalledOnce();
  });

  it('resolves Apple contact identities without inserting raw events', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
      mockConnector,
    } = createMockDeps();
    const setTunnelTransport = vi.fn();
    const resolvePerson = vi.fn().mockResolvedValue({ id: 'person-1' });
    Object.assign(mockConnector, { setTunnelTransport });
    mockConnector.sync.mockImplementation(async () => {
      mockConnector.emit('identity', {
        source: 'apple_contacts',
        contact: {
          id: 'local-contact-1',
          displayName: 'Ada Lovelace',
          emails: ['ada@example.com'],
          phones: ['+15551234567'],
        },
      });
      return { cursor: null, hasMore: false, processed: 0 };
    });
    vi.mocked(accountsService.getById).mockResolvedValue({
      id: 'apple-1',
      connectorType: 'apple',
      authContext: '{"raw":{"tunnelMode":true}}',
      lastCursor: null,
      itemsSynced: 0,
      tunnelMode: true,
    } as never);
    vi.mocked(moduleRef.get).mockImplementation((token: unknown) => {
      if (token === AppleTunnelService) return { isConnected: vi.fn() } as never;
      if (token === PeopleService) return { resolvePerson } as never;
      return null as never;
    });

    const processor = new SyncProcessor(
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cryptoService as unknown as import('../../crypto/crypto.service').CryptoService,
      memoryQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
      moduleRef,
    );

    await processor.process({
      data: { accountId: 'apple-1', connectorType: 'apple', jobId: 'j1' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as unknown as import('bullmq').Job);

    expect(resolvePerson).toHaveBeenCalledWith(
      expect.arrayContaining([
        { type: 'email', value: 'ada@example.com', connectorType: 'apple' },
        { type: 'phone', value: '+15551234567', connectorType: 'apple' },
        { type: 'apple_contact_id', value: 'local-contact-1', connectorType: 'apple' },
        { type: 'name', value: 'Ada Lovelace', connectorType: 'apple' },
      ]),
      'person',
      'user-1',
    );
    expect(memoryQueue.add).not.toHaveBeenCalled();
  });
});
