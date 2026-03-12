import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock bullmq and nestjs/bullmq before importing the processor
vi.mock('bullmq', () => {
  const QueueMock = vi.fn().mockImplementation(() => ({
    getWaiting: vi.fn().mockResolvedValue([]),
    getDelayed: vi.fn().mockResolvedValue([]),
    getFailed: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
  }));
  return { Queue: QueueMock, Worker: vi.fn() };
});

vi.mock('@nestjs/bullmq', () => ({
  Processor: () => () => {},
  InjectQueue: () => () => {},
  WorkerHost: class {
    worker = {
      on: vi.fn(),
      concurrency: 32,
      opts: { connection: {} },
    };
  },
}));

import { CleanProcessor } from '../clean.processor';
import { DbService } from '../../db/db.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AccountsService } from '../../accounts/accounts.service';
import { ContactsService } from '../../contacts/contacts.service';
import { EventsService } from '../../events/events.service';
import { LogsService } from '../../logs/logs.service';
import { JobsService } from '../../jobs/jobs.service';
import { SettingsService } from '../../settings/settings.service';
import { TraceContext } from '../../tracing/trace.context';
import type { Job } from 'bullmq';

function createMockDbService() {
  return {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    },
  } as unknown as DbService;
}

function createMockConnectorsService() {
  return {
    get: vi.fn().mockReturnValue({
      manifest: { pipeline: { clean: true, embed: true } },
      clean: vi.fn().mockResolvedValue({ text: 'cleaned text' }),
      embed: vi.fn().mockResolvedValue({ entities: [] }),
      extractFile: vi.fn().mockResolvedValue('extracted file content'),
    }),
  } as unknown as ConnectorsService;
}

function createMockAccountsService() {
  return {
    getById: vi.fn().mockResolvedValue({ authContext: '{}' }),
  } as unknown as AccountsService;
}

function createMockContactsService() {
  return {
    resolveContact: vi.fn().mockResolvedValue({ id: 'contact-1' }),
  } as unknown as ContactsService;
}

function createMockEventsService() {
  return {
    emitToChannel: vi.fn(),
  } as unknown as EventsService;
}

function createMockLogsService() {
  return {
    add: vi.fn(),
  } as unknown as LogsService;
}

function createMockJobsService() {
  return {
    incrementProgress: vi.fn().mockResolvedValue({ progress: 1, total: 10 }),
    tryCompleteJob: vi.fn().mockResolvedValue(false),
  } as unknown as JobsService;
}

function createMockSettingsService() {
  return {
    get: vi.fn().mockResolvedValue('32'),
    onChange: vi.fn(),
  } as unknown as SettingsService;
}

function createMockTraceContext() {
  return {
    run: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
    current: vi.fn().mockReturnValue({ traceId: 'trace-123', spanId: 'span-456' }),
  } as unknown as TraceContext;
}

function createMockQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  };
}

function createJob(data: Record<string, unknown>): Job {
  return { data } as unknown as Job;
}

describe('CleanProcessor', () => {
  let processor: CleanProcessor;
  let dbService: DbService;
  let connectors: ConnectorsService;
  let contactsService: ContactsService;
  let eventsService: EventsService;
  let logsService: LogsService;
  let jobsService: JobsService;
  let embedQueue: ReturnType<typeof createMockQueue>;
  let cleanQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    dbService = createMockDbService();
    connectors = createMockConnectorsService();
    const accountsService = createMockAccountsService();
    contactsService = createMockContactsService();
    eventsService = createMockEventsService();
    logsService = createMockLogsService();
    jobsService = createMockJobsService();
    const settingsService = createMockSettingsService();
    cleanQueue = createMockQueue();
    embedQueue = createMockQueue();
    const traceContext = createMockTraceContext();

    processor = new CleanProcessor(
      dbService,
      connectors,
      accountsService,
      contactsService,
      eventsService,
      logsService,
      jobsService,
      settingsService,
      cleanQueue as any,
      embedQueue as any,
      traceContext,
    );
  });

  describe('process', () => {
    it('returns early when rawEvent not found', async () => {
      // db.select().from().where() returns empty array
      (dbService.db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const job = createJob({ rawEventId: 'missing-id' });
      await processor.process(job as any);

      expect(embedQueue.add).not.toHaveBeenCalled();
    });

    it('cleans text, dedup checks, and enqueues embed job', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: 'raw text', metadata: {} },
        }),
        cleanedText: null,
      };

      // Mock select for rawEvents lookup
      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      // Mock update for cleanedText
      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Mock select for dedup check (no existing memory)
      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(embedQueue.add).toHaveBeenCalledWith(
        'embed',
        expect.objectContaining({ rawEventId: 'raw-1' }),
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('skips duplicate events', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: 'some text', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Dedup check returns existing memory
      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'existing-memory' }]),
          }),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      // Should NOT enqueue embed job
      expect(embedQueue.add).not.toHaveBeenCalled();
      // Should advance progress
      expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-1');
    });

    it('skips events with empty cleaned text', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: '', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      // Connector clean returns empty text
      const connector = (connectors.get as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (connector) connector.clean = vi.fn().mockResolvedValue({ text: '' });
      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true, embed: true } },
        clean: vi.fn().mockResolvedValue({ text: '   ' }),
        embed: vi.fn(),
        extractFile: vi.fn(),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(embedQueue.add).not.toHaveBeenCalled();
      expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-1');
    });

    it('handles contact-only events without creating memory', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'contact',
          content: { text: 'John Doe', metadata: { type: 'contact' } },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Connector embed returns entities for contact resolution
      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true, embed: true } },
        clean: vi.fn().mockResolvedValue({ text: 'John Doe' }),
        embed: vi.fn().mockResolvedValue({
          entities: [
            { type: 'person', id: 'email:john@example.com|name:John Doe', role: 'subject' },
          ],
        }),
        extractFile: vi.fn(),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(contactsService.resolveContact).toHaveBeenCalled();
      expect(embedQueue.add).not.toHaveBeenCalled();
      expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-1');
    });

    it('skips embed when pipeline.embed is false', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: 'text', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // No dedup match
      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // Pipeline embed disabled
      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true, embed: false } },
        clean: vi.fn().mockResolvedValue({ text: 'cleaned' }),
        embed: vi.fn(),
        extractFile: vi.fn(),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(embedQueue.add).not.toHaveBeenCalled();
      expect(jobsService.incrementProgress).toHaveBeenCalledWith('job-1');
    });
  });

  describe('sanitizeText (via process)', () => {
    it('strips control characters from text', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: null,
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-unique-1',
          sourceType: 'email',
          content: { text: 'clean text', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      // Connector returns text with control chars
      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true, embed: true } },
        clean: vi.fn().mockResolvedValue({ text: 'hello\u0000\u200Bworld' }),
        embed: vi.fn(),
        extractFile: vi.fn(),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // No dedup
      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      // The embed queue should receive the job (text is "helloworld" after sanitize)
      expect(embedQueue.add).toHaveBeenCalled();
    });
  });

  describe('advanceAndComplete', () => {
    it('emits job:complete when job is done', async () => {
      (jobsService.tryCompleteJob as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const rawEvent = {
        id: 'raw-1',
        jobId: 'job-1',
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: '', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true } },
        clean: vi.fn().mockResolvedValue({ text: '' }),
        embed: vi.fn(),
        extractFile: vi.fn(),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(eventsService.emitToChannel).toHaveBeenCalledWith(
        'job:job-1',
        'job:progress',
        expect.any(Object),
      );
      expect(eventsService.emitToChannel).toHaveBeenCalledWith(
        'job:job-1',
        'job:complete',
        expect.objectContaining({ jobId: 'job-1', status: 'done' }),
      );
    });

    it('does not advance when jobId is null', async () => {
      const rawEvent = {
        id: 'raw-1',
        jobId: null,
        connectorType: 'gmail',
        accountId: 'acct-1',
        payload: JSON.stringify({
          sourceId: 'src-1',
          sourceType: 'email',
          content: { text: '', metadata: {} },
        }),
        cleanedText: null,
      };

      (dbService.db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([rawEvent]),
        }),
      });

      (connectors.get as ReturnType<typeof vi.fn>).mockReturnValue({
        manifest: { pipeline: { clean: true } },
        clean: vi.fn().mockResolvedValue({ text: '' }),
        embed: vi.fn(),
        extractFile: vi.fn(),
      });

      (dbService.db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const job = createJob({ rawEventId: 'raw-1' });
      await processor.process(job as any);

      expect(jobsService.incrementProgress).not.toHaveBeenCalled();
    });
  });
});
