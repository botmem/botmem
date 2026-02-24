import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncProcessor } from '../sync.processor';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AccountsService } from '../../accounts/accounts.service';
import { JobsService } from '../jobs.service';
import { LogsService } from '../../logs/logs.service';
import { EventsService } from '../../events/events.service';
import { EventEmitter } from 'events';

function createMockDeps() {
  const mockConnector = Object.assign(new EventEmitter(), {
    manifest: { id: 'gmail' },
    sync: vi.fn(),
    removeAllListeners: vi.fn(),
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

  const jobsService = {
    updateJob: vi.fn().mockResolvedValue(undefined),
    triggerSync: vi.fn().mockResolvedValue({}),
  } as unknown as JobsService;

  const logsService = {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as LogsService;

  const events = {
    emitToChannel: vi.fn(),
  } as unknown as EventsService;

  return { connectors, accountsService, jobsService, logsService, events, mockConnector };
}

describe('SyncProcessor', () => {
  it('processes sync job successfully', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockResolvedValue({ cursor: 'c1', hasMore: false, processed: 10 });

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);

    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;
    await processor.process(job);

    expect(jobsService.updateJob).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'running' }));
    expect(accountsService.update).toHaveBeenCalledWith('acc-1', expect.objectContaining({ status: 'syncing' }));
    expect(jobsService.updateJob).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'done', progress: 10 }));
    expect(accountsService.update).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      lastCursor: 'c1',
      status: 'connected',
      itemsSynced: 15,
    }));
    expect(events.emitToChannel).toHaveBeenCalledWith('job:j1', 'job:complete', { jobId: 'j1', status: 'done' });
    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });

  it('handles error during sync', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockRejectedValue(new Error('API rate limited'));

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);
    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;

    await expect(processor.process(job)).rejects.toThrow('API rate limited');

    expect(jobsService.updateJob).toHaveBeenCalledWith('j1', expect.objectContaining({
      status: 'failed',
      error: 'API rate limited',
    }));
    expect(accountsService.update).toHaveBeenCalledWith('acc-1', { status: 'error' });
    expect(events.emitToChannel).toHaveBeenCalledWith('job:j1', 'job:complete', { jobId: 'j1', status: 'failed' });
    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });

  it('triggers follow-up sync when hasMore is true', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockResolvedValue({ cursor: 'c2', hasMore: true, processed: 50 });

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);
    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;
    await processor.process(job);

    expect(jobsService.triggerSync).toHaveBeenCalledWith('acc-1', 'gmail');
  });

  it('does not trigger follow-up when hasMore is false', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockResolvedValue({ cursor: null, hasMore: false, processed: 5 });

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);
    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;
    await processor.process(job);

    expect(jobsService.triggerSync).not.toHaveBeenCalled();
  });

  it('creates logger that adds logs', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockImplementation(async (ctx: any) => {
      ctx.logger.info('started');
      ctx.logger.warn('slow');
      ctx.logger.error('oops');
      ctx.logger.debug('trace');
      return { cursor: null, hasMore: false, processed: 0 };
    });

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);
    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;
    await processor.process(job);

    expect(logsService.add).toHaveBeenCalledTimes(4);
    expect(logsService.add).toHaveBeenCalledWith(expect.objectContaining({ level: 'info', message: 'started' }));
  });

  it('cleans up listeners in finally block', async () => {
    const { connectors, accountsService, jobsService, logsService, events, mockConnector } = createMockDeps();
    mockConnector.sync.mockRejectedValue(new Error('fail'));

    const processor = new SyncProcessor(connectors, accountsService, jobsService, logsService, events);
    const job = { data: { accountId: 'acc-1', connectorType: 'gmail', jobId: 'j1' } } as any;

    try { await processor.process(job); } catch {}

    expect(mockConnector.removeAllListeners).toHaveBeenCalled();
  });
});
