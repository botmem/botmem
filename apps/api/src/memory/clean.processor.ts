import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { PeopleService, IdentifierInput } from '../people/people.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { rawEvents, memories } from '../db/schema';
import { TraceContext, generateTraceId, generateSpanId } from '../tracing/trace.context';
import type { ConnectorDataEvent, PipelineContext, ConnectorLogger } from '@botmem/connector-sdk';
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeText(text: string): string {
  return text.replace(INVISIBLE_RE, '').replace(CONTROL_RE, '').trim();
}

@Processor('clean')
export class CleanProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CleanProcessor.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private contactsService: PeopleService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    private traceContext: TraceContext,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[clean worker] ${err.message}`));
    this.worker.on('failed', (job, err) => this.onJobFailed(job, err));
    const concurrency = parseInt(await this.settingsService.get('clean_concurrency'), 10) || 32;
    this.worker.concurrency = concurrency;
    this.settingsService.onChange((key, value) => {
      if (key === 'clean_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 32;
      }
    });

    // Migrate jobs from the old monolithic 'memory' queue to 'clean'
    await this.migrateOldMemoryQueue();
  }

  private async onJobFailed(job: Job | undefined, err: Error) {
    if (!job) return;
    const { rawEventId } = job.data;
    const mid = rawEventId?.slice(0, 8) || '?';
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isLastAttempt) return;

    // Look up parent job and connector info for logging
    try {
      const rows = await this.dbService.db
        .select({
          jobId: rawEvents.jobId,
          connectorType: rawEvents.connectorType,
          accountId: rawEvents.accountId,
        })
        .from(rawEvents)
        .where(eq(rawEvents.id, rawEventId));
      const raw = rows[0];
      if (raw) {
        this.addLog(
          raw.connectorType,
          raw.accountId,
          'error',
          `[clean:failed] ${mid} exhausted ${job.attemptsMade} retries: ${err.message}`,
          raw.jobId,
        );
      }
    } catch {
      this.logger.warn(`[clean:failed] ${mid}: ${err.message}`);
    }
  }

  private async migrateOldMemoryQueue() {
    try {
      const oldQueue = new Queue('memory', {
        connection: this.worker.opts.connection as import('bullmq').ConnectionOptions,
      });
      const waiting = await oldQueue.getWaiting(0, 1000);
      const delayed = await oldQueue.getDelayed(0, 1000);
      const all = [...waiting, ...delayed];
      if (!all.length) {
        await oldQueue.close();
        return;
      }
      this.logger.log(`[clean] Migrating ${all.length} jobs from old 'memory' queue to 'clean'`);
      for (const job of all) {
        await this.cleanQueue.add('clean', job.data, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        });
        await job.remove();
      }
      // Also drain failed
      const failed = await oldQueue.getFailed(0, 5000);
      for (const job of failed) {
        await job.remove();
      }
      await oldQueue.close();
      this.logger.log(`[clean] Migration complete`);
    } catch (err: unknown) {
      this.logger.warn(
        `[clean] Old queue migration skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(job: Job<{ rawEventId: string; _trace?: { traceId: string; spanId: string } }>) {
    const trace = job.data._trace;
    const traceId = trace?.traceId || generateTraceId();
    const spanId = generateSpanId();
    return this.traceContext.run({ traceId, spanId }, () => this._process(job));
  }

  private async _process(
    job: Job<{ rawEventId: string; _trace?: { traceId: string; spanId: string } }>,
  ) {
    const { rawEventId } = job.data;
    const currentTrace = this.traceContext.current()!;

    const rows = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    if (!rows.length) return;
    const rawEvent = rows[0];
    const parentJobId = rawEvent.jobId;
    const mid = rawEventId.slice(0, 8);

    const event: ConnectorDataEvent = JSON.parse(
      this.crypto.decrypt(rawEvent.payload) || rawEvent.payload,
    );
    const connector = this.connectors.get(rawEvent.connectorType);

    // Clean
    const ctx = await this.buildPipelineContext(
      rawEvent.accountId,
      rawEvent.connectorType,
      parentJobId,
    );
    const pipelineClean = connector.manifest.pipeline?.clean !== false;

    let text = event.content?.text || '';

    if (pipelineClean) {
      // Handle file events
      if (event.sourceType === 'file') {
        const metadata = event.content?.metadata || {};
        const fileUrl = metadata.fileUrl as string | undefined;
        const mimetype = metadata.mimetype as string | undefined;
        if (fileUrl) {
          try {
            const extracted = await connector.extractFile(fileUrl, mimetype || '', ctx.auth);
            if (extracted) {
              event.content.text =
                extracted + (event.content.text ? `\n\n${event.content.text}` : '');
            }
          } catch (err: unknown) {
            ctx.logger.warn(
              `[clean:file-extract] ${mid} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const cleanResult = await connector.clean(event, ctx);
      text = cleanResult.text?.trim() || '';

      await this.dbService.db
        .update(rawEvents)
        .set({ cleanedText: this.crypto.encrypt(text) })
        .where(eq(rawEvents.id, rawEventId));
    } else {
      text =
        (rawEvent.cleanedText
          ? this.crypto.decrypt(rawEvent.cleanedText) || rawEvent.cleanedText
          : '') || text;
    }

    text = sanitizeText(text);

    if (!text) {
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const metadata = event.content?.metadata || {};

    // Contact-only events — resolve contacts, don't create memory
    if (metadata.type === 'contact') {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[clean:contact-only] ${mid} — resolving contact without creating memory`,
        parentJobId,
      );
      try {
        const embedResult = await connector.embed(event, text, ctx);
        const buckets: Array<{ entityType: string; identifiers: IdentifierInput[] }> = [];
        for (const entity of embedResult.entities) {
          if (
            entity.type === 'person' ||
            entity.type === 'group' ||
            entity.type === 'organization'
          ) {
            const identifiers = this.parseEntityIdentifiers(entity, rawEvent.connectorType);
            let merged = false;
            for (const bucket of buckets) {
              if (bucket.entityType !== entity.type) continue;
              const bucketValues = new Set(bucket.identifiers.map((i) => i.value));
              if (identifiers.some((id) => bucketValues.has(id.value))) {
                bucket.identifiers.push(...identifiers);
                merged = true;
                break;
              }
            }
            if (!merged) {
              buckets.push({ entityType: entity.type, identifiers: [...identifiers] });
            }
          }
        }
        for (const { entityType, identifiers } of buckets) {
          await this.contactsService.resolvePerson(
            identifiers,
            entityType === 'person'
              ? undefined
              : (entityType as 'group' | 'organization' | 'device'),
          );
        }
      } catch {
        // Contact resolution is best-effort
      }
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // Dedup
    const existing = await this.dbService.db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.sourceId, event.sourceId),
          eq(memories.connectorType, rawEvent.connectorType),
        ),
      )
      .limit(1);

    if (existing.length) {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[clean:dedup] ${mid} — skipping duplicate source_id ${event.sourceId.slice(0, 30)}`,
        parentJobId,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // Check pipeline.embed flag
    const pipelineEmbed = connector.manifest.pipeline?.embed !== false;
    if (!pipelineEmbed) {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[clean:skip] ${mid} — pipeline.embed=false`,
        parentJobId,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // Enqueue to embed stage
    await this.embedQueue.add(
      'embed',
      { rawEventId, _trace: { traceId: currentTrace.traceId, spanId: currentTrace.spanId } },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
  }

  private parseEntityIdentifiers(
    entity: { type: string; id: string; role: string },
    connectorType: string,
  ): IdentifierInput[] {
    const identifiers: IdentifierInput[] = [];
    const parts = entity.id.split('|');
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) {
        identifiers.push({ type: entity.type, value: part, connectorType });
      } else {
        identifiers.push({
          type: part.slice(0, colonIdx),
          value: part.slice(colonIdx + 1),
          connectorType,
        });
      }
    }
    return identifiers;
  }

  private async advanceAndComplete(jobId: string | null | undefined) {
    if (!jobId) return;
    try {
      const result = await this.jobsService.incrementProgress(jobId);
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
        jobId,
        processed: result.progress,
        total: result.total,
      });
      const done = await this.jobsService.tryCompleteJob(jobId);
      if (done) {
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
      }
    } catch {
      // Non-fatal
    }
  }

  private async buildPipelineContext(
    accountId: string,
    connectorType: string,
    jobId?: string | null,
  ): Promise<PipelineContext> {
    let auth: Record<string, unknown> = {};
    try {
      const account = await this.accountsService.getById(accountId);
      if (account.authContext) auth = JSON.parse(account.authContext) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    const logger: ConnectorLogger = {
      info: (msg) => this.addLog(connectorType, accountId, 'info', msg, jobId),
      warn: (msg) => this.addLog(connectorType, accountId, 'warn', msg, jobId),
      error: (msg) => this.addLog(connectorType, accountId, 'error', msg, jobId),
      debug: (msg) => this.addLog(connectorType, accountId, 'debug', msg, jobId),
    };
    return { accountId, auth, logger };
  }

  private addLog(
    connectorType: string,
    accountId: string | null,
    level: string,
    message: string,
    jobId?: string | null,
  ) {
    const stage = 'clean';
    this.logsService.add({
      jobId: jobId ?? undefined,
      connectorType,
      accountId: accountId ?? undefined,
      stage,
      level,
      message,
    });
    this.events.emitToChannel('logs', 'log', {
      jobId: jobId ?? undefined,
      connectorType,
      accountId,
      stage,
      level,
      message,
      timestamp: new Date(),
    });
  }
}
