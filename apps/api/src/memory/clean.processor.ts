import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { rawEvents, memories } from '../db/schema';
import type { ConnectorDataEvent, PipelineContext, ConnectorLogger } from '@botmem/connector-sdk';

function sanitizeText(text: string): string {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uFFF9-\uFFFB]/g,
      '',
    )
    .trim();
}

@Processor('clean')
export class CleanProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CleanProcessor.name);
  constructor(
    private dbService: DbService,
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private contactsService: ContactsService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[clean worker] ${err.message}`));
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

  private async migrateOldMemoryQueue() {
    try {
      const oldQueue = new Queue('memory', { connection: this.worker.opts.connection as any });
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
    } catch (err: any) {
      this.logger.warn(`[clean] Old queue migration skipped: ${err.message}`);
    }
  }

  async process(job: Job<{ rawEventId: string }>) {
    const { rawEventId } = job.data;

    const rows = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    if (!rows.length) return;
    const rawEvent = rows[0];
    const parentJobId = rawEvent.jobId;
    const mid = rawEventId.slice(0, 8);

    const event: ConnectorDataEvent = JSON.parse(rawEvent.payload);
    const connector = this.connectors.get(rawEvent.connectorType);

    // Clean
    const ctx = await this.buildPipelineContext(rawEvent.accountId, rawEvent.connectorType);
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
          } catch (err: any) {
            ctx.logger.warn(`[clean:file-extract] ${mid} failed: ${err?.message}`);
          }
        }
      }

      const cleanResult = await connector.clean(event, ctx);
      text = cleanResult.text?.trim() || '';

      await this.dbService.db
        .update(rawEvents)
        .set({ cleanedText: text })
        .where(eq(rawEvents.id, rawEventId));
    } else {
      text = rawEvent.cleanedText || text;
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
          await this.contactsService.resolveContact(
            identifiers,
            entityType === 'person' ? undefined : (entityType as any),
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
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // Enqueue to embed stage
    await this.embedQueue.add(
      'embed',
      { rawEventId },
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
  ): Promise<PipelineContext> {
    let auth: any = {};
    try {
      const account = await this.accountsService.getById(accountId);
      if (account.authContext) auth = JSON.parse(account.authContext);
    } catch {
      /* empty */
    }
    const logger: ConnectorLogger = {
      info: (msg) => this.addLog(connectorType, accountId, 'info', msg),
      warn: (msg) => this.addLog(connectorType, accountId, 'warn', msg),
      error: (msg) => this.addLog(connectorType, accountId, 'error', msg),
      debug: (msg) => this.addLog(connectorType, accountId, 'debug', msg),
    };
    return { accountId, auth, logger };
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'clean';
    this.logsService.add({
      connectorType,
      accountId: accountId ?? undefined,
      stage,
      level,
      message,
    });
    this.events.emitToChannel('logs', 'log', {
      connectorType,
      accountId,
      stage,
      level,
      message,
      timestamp: new Date(),
    });
  }
}
