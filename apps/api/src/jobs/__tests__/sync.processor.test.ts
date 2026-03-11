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

function createMockDeps() {
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
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          then: vi.fn(),
        }),
      }),
    },
    withUserId: vi
      .fn()
      .mockImplementation(
        (_uid: string, fn: (db: Record<string, ReturnType<typeof vi.fn>>) => Promise<void>) =>
          fn({
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockResolvedValue(undefined),
            }),
          }),
      ),
  } as unknown as DbService;

  const cleanQueue = {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('bullmq').Queue;

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
  } as unknown as { current: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };

  return {
    connectors,
    accountsService,
    authService,
    jobsService,
    logsService,
    events,
    dbService,
    cleanQueue,
    settingsService,
    configService,
    analytics,
    traceContext,
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
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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

  it('handles error during sync', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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
      expect.objectContaining({ status: 'error' }),
    );
    expect(events.emitToChannel).toHaveBeenCalledWith('job:j1', 'job:complete', {
      jobId: 'j1',
      status: 'failed',
    });
    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
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
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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

  it('creates logger that adds logs', async () => {
    const {
      connectors,
      accountsService,
      authService,
      jobsService,
      logsService,
      events,
      dbService,
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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
      cleanQueue,
      settingsService,
      configService,
      analytics,
      traceContext,
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
      cleanQueue,
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
});
