import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AiService } from './ai.service';
import { QdrantService } from './qdrant.service';
import { EnrichService } from './enrich.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { rawEvents, memories, memoryLinks } from '../db/schema';
import { photoDescriptionPrompt } from './prompts';
import type { ConnectorDataEvent, PipelineContext, ConnectorLogger } from '@botmem/connector-sdk';

const MAX_CONTENT_LENGTH = 10_000;
const TRUNCATION_SUFFIX = '\n\n---\n*[Truncated]*';

/**
 * Strip invisible / non-printable Unicode characters that appear in raw SMS
 * and other sources. Keeps normal whitespace (\n, \r, \t, space) and all
 * visible Unicode (including Arabic, CJK, emoji, etc.).
 */
function sanitizeText(text: string): string {
  return (
    text
      // Remove U+0000–U+0008, U+000B, U+000C, U+000E–U+001F (C0 controls except \t \n \r)
      // Remove U+007F (DEL)
      // Remove U+0080–U+009F (C1 controls)
      // Remove U+200B–U+200F (zero-width spaces, LTR/RTL marks)
      // Remove U+202A–U+202E (embedding/override directional)
      // Remove U+2060–U+2064 (word joiner, invisible operators)
      // Remove U+FEFF (BOM / zero-width no-break space)
      // Remove U+FFF9–U+FFFB (interlinear annotation anchors)
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uFFF9-\uFFFB]/g,
        '',
      )
      .trim()
  );
}

export type PipelineStage = 'clean' | 'embed' | 'enrich';

@Processor('memory')
export class MemoryProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MemoryProcessor.name);
  /** Track how many jobs are in each logical stage right now */
  private stageCounts: Record<PipelineStage, number> = { clean: 0, embed: 0, enrich: 0 };
  /** Completed count per stage (reset when all jobs drain) */
  private stageCompleted: Record<PipelineStage, number> = { clean: 0, embed: 0, enrich: 0 };

  getStageCounts() {
    return {
      clean: { ...this.stageCounts, stage: 'clean' as const, completed: this.stageCompleted.clean },
      embed: { ...this.stageCounts, stage: 'embed' as const, completed: this.stageCompleted.embed },
      enrich: {
        ...this.stageCounts,
        stage: 'enrich' as const,
        completed: this.stageCompleted.enrich,
      },
    };
  }

  getStageStats() {
    return {
      clean: this.stageCounts.clean,
      embed: this.stageCounts.embed,
      enrich: this.stageCounts.enrich,
    };
  }

  private enterStage(stage: PipelineStage) {
    this.stageCounts[stage]++;
  }
  private leaveStage(stage: PipelineStage) {
    this.stageCounts[stage] = Math.max(0, this.stageCounts[stage] - 1);
    this.stageCompleted[stage]++;
  }

  constructor(
    private dbService: DbService,
    private ai: AiService,
    private qdrant: QdrantService,
    private enrichService: EnrichService,
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private contactsService: ContactsService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private pluginRegistry: PluginRegistry,
    private config: ConfigService,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[memory worker] ${err.message}`));
    const defaultC = this.config.aiConcurrency.memory;
    const concurrency =
      parseInt(await this.settingsService.get('memory_concurrency'), 10) || defaultC;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'memory_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultC;
      }
    });
  }

  async process(job: Job<{ rawEventId: string }>) {
    const { rawEventId } = job.data;

    // 1. Read raw event
    const rows = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    if (!rows.length) return;
    const rawEvent = rows[0];
    const parentJobId = rawEvent.jobId;
    const mid = rawEventId.slice(0, 8);

    // 2. Parse payload
    const event: ConnectorDataEvent = JSON.parse(rawEvent.payload);
    const connector = this.connectors.get(rawEvent.connectorType);

    // 3. Clean
    this.enterStage('clean');
    const ctx = await this.buildPipelineContext(rawEvent.accountId, rawEvent.connectorType);
    const pipelineClean = connector.manifest.pipeline?.clean !== false;

    let text = event.content?.text || '';

    if (pipelineClean) {
      // Handle file events — call connector.extractFile() first
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
              `[memory:file-extract] ${mid} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const cleanResult = await connector.clean(event, ctx);
      text = cleanResult.text?.trim() || '';

      // Store cleaned text on raw event
      await this.dbService.db
        .update(rawEvents)
        .set({ cleanedText: text })
        .where(eq(rawEvents.id, rawEventId));
    } else {
      text = rawEvent.cleanedText || text;
    }

    // Strip invisible control characters (e.g. BOM, zero-width spaces in raw SMS)
    text = sanitizeText(text);
    this.leaveStage('clean');

    if (!text) {
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const metadata = event.content?.metadata || {};
    const attachments = event.content?.attachments;
    if (attachments?.length) {
      metadata.attachments = attachments;
    }

    // 4. Contact-only events
    if (metadata.type === 'contact') {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[memory:contact-only] ${mid} — resolving contact without creating memory`,
      );
      try {
        const embedResult = await connector.embed(event, text, ctx);
        const buckets: Array<{ entityType: string; identifiers: IdentifierInput[] }> = [];
        for (const entity of embedResult.entities) {
          if (entity.type === 'person' || entity.type === 'group') {
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
            entityType === 'person' ? undefined : entityType,
          );
        }
      } catch {
        // Contact resolution is best-effort
      }
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // 5. Dedup
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
        `[memory:dedup] ${mid} — skipping duplicate source_id ${event.sourceId.slice(0, 30)}`,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // 6. Check pipeline.embed flag
    const pipelineEmbed = connector.manifest.pipeline?.embed !== false;
    if (!pipelineEmbed) {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[memory:skip] ${mid} — pipeline.embed=false`,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[memory:start] ${event.sourceType} ${mid} (${text.length} chars) "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
    );

    const pipelineStart = Date.now();
    this.enterStage('embed');

    // 7. Call connector.embed() for entity extraction
    const embedResult = await connector.embed(event, text, ctx);
    const embedText = embedResult.text || text;

    // 8. Create memory record
    const memoryId = randomUUID();
    const now = new Date();
    const mergedMetadata = { ...metadata, ...(embedResult.metadata || {}) };

    let t0 = Date.now();
    await this.dbService.db.insert(memories).values({
      id: memoryId,
      accountId: rawEvent.accountId,
      connectorType: rawEvent.connectorType,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      text: embedText,
      eventTime: new Date(event.timestamp),
      ingestTime: now,
      metadata: JSON.stringify(mergedMetadata),
      embeddingStatus: 'pending',
      createdAt: now,
    });
    const dbInsertMs = Date.now() - t0;

    // Fire afterIngest hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterIngest', {
      id: memoryId,
      text: embedText,
      sourceType: event.sourceType,
      connectorType: rawEvent.connectorType,
      eventTime: new Date(event.timestamp),
    });

    // 9. Contact resolution + linking
    t0 = Date.now();
    let contactCount = 0;
    try {
      const buckets: Array<{ entityType: string; role: string; identifiers: IdentifierInput[] }> =
        [];

      for (const entity of embedResult.entities) {
        if (entity.type === 'person' || entity.type === 'group' || entity.type === 'device') {
          const identifiers = this.parseEntityIdentifiers(entity, rawEvent.connectorType);
          let merged = false;
          for (const bucket of buckets) {
            if (bucket.entityType !== entity.type || bucket.role !== entity.role) continue;
            const bucketValues = new Set(bucket.identifiers.map((i) => i.value));
            if (identifiers.some((id) => bucketValues.has(id.value))) {
              bucket.identifiers.push(...identifiers);
              merged = true;
              break;
            }
          }
          if (!merged) {
            buckets.push({
              entityType: entity.type,
              role: entity.role,
              identifiers: [...identifiers],
            });
          }
        }
        if (entity.type === 'message' && entity.id.startsWith('thread:')) {
          await this.linkThread(memoryId, entity.id.replace('thread:', ''), rawEvent.connectorType);
        }
      }

      for (const { entityType, role, identifiers } of buckets) {
        const resolveType = entityType === 'person' ? undefined : entityType;
        const contact = await this.contactsService.resolveContact(identifiers, resolveType);
        if (contact) {
          await this.contactsService.linkMemory(memoryId, contact.id, role);
          contactCount++;
        }
      }
    } catch (err) {
      this.logger.error(
        'Contact resolution failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
    const contactMs = Date.now() - t0;

    // 10. Thread linking from metadata
    if (mergedMetadata.threadId) {
      try {
        await this.linkThread(memoryId, mergedMetadata.threadId as string, rawEvent.connectorType);
      } catch {
        // Thread linking is best-effort
      }
    }

    // 11. Generate embedding + store in Qdrant
    const maxChars = 6000;
    let currentText = embedText;
    const truncatedText =
      currentText.length > maxChars ? currentText.slice(0, maxChars) : currentText;
    try {
      t0 = Date.now();
      let vector = await this.ai.embed(truncatedText);
      const embedMs = Date.now() - t0;

      t0 = Date.now();
      await this.qdrant.upsert(memoryId, vector, {
        source_type: event.sourceType,
        connector_type: rawEvent.connectorType,
        event_time: event.timestamp,
        account_id: rawEvent.accountId,
      });
      const qdrantMs = Date.now() - t0;

      // Fire afterEmbed hook (fire-and-forget)
      void this.pluginRegistry.fireHook('afterEmbed', {
        id: memoryId,
        text: embedText,
        sourceType: event.sourceType,
        connectorType: rawEvent.connectorType,
        eventTime: new Date(event.timestamp),
      });

      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'info',
        `[memory:embedded] ${memoryId.slice(0, 8)} in ${Date.now() - pipelineStart}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) ollama=${embedMs}ms(${vector.length}d) qdrant=${qdrantMs}ms`,
      );

      // 12. File processing (image → VL model description → re-embed)
      if (mergedMetadata.fileUrl && (mergedMetadata.mimetype as string)?.startsWith('image/')) {
        try {
          const fileContent = await this.processFile(memoryId, mergedMetadata, rawEvent);
          if (fileContent) {
            currentText = fileContent + '\n\n' + currentText;
            await this.dbService.db
              .update(memories)
              .set({ text: currentText })
              .where(eq(memories.id, memoryId));

            // Re-embed with enriched text
            const reEmbedText =
              currentText.length > maxChars ? currentText.slice(0, maxChars) : currentText;
            vector = await this.ai.embed(reEmbedText);
            await this.qdrant.upsert(memoryId, vector, {
              source_type: event.sourceType,
              connector_type: rawEvent.connectorType,
              event_time: event.timestamp,
              account_id: rawEvent.accountId,
            });
          }
        } catch (err: unknown) {
          this.addLog(
            rawEvent.connectorType,
            rawEvent.accountId,
            'warn',
            `[memory:file] ${mid} file processing failed: ${err?.message}`,
          );
        }
      }

      // 13. Enrich (entities, factuality, links, weights)
      this.leaveStage('embed');
      this.enterStage('enrich');
      const pipelineEnrich = connector.manifest.pipeline?.enrich !== false;
      if (pipelineEnrich) {
        await this.enrichService.enrich(memoryId);

        // Fire afterEnrich hook (fire-and-forget)
        const [enrichedMem] = await this.dbService.db
          .select({ entities: memories.entities, factuality: memories.factuality })
          .from(memories)
          .where(eq(memories.id, memoryId));
        void this.pluginRegistry.fireHook('afterEnrich', {
          id: memoryId,
          text: currentText,
          sourceType: event.sourceType,
          connectorType: rawEvent.connectorType,
          eventTime: new Date(event.timestamp),
          entities: enrichedMem?.entities,
          factuality: enrichedMem?.factuality,
        });
      }

      // 14. Mark done
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, memoryId));

      this.events.emitToChannel('memories', 'memory:updated', {
        memoryId,
        sourceType: event.sourceType,
        connectorType: rawEvent.connectorType,
        text: currentText.slice(0, 100),
      });

      this.leaveStage('enrich');

      // 15. Advance progress + try complete
      await this.advanceAndComplete(parentJobId);
    } catch (err: unknown) {
      const totalMs = Date.now() - pipelineStart;
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'failed' })
        .where(eq(memories.id, memoryId));
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'error',
        `[memory:fail] ${event.sourceType} after ${totalMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private async processFile(
    memoryId: string,
    metadata: Record<string, unknown>,
    rawEvent: Record<string, unknown>,
  ): Promise<string | null> {
    const fileUrl = metadata.fileUrl as string;
    const mimetype = (metadata.mimetype as string) || '';
    const fileName = (metadata.fileName as string) || '';
    const mid = memoryId.slice(0, 8);

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[memory:file] ${mid} "${fileName || 'unknown'}" (${mimetype || 'unknown'})`,
    );

    const headers = await this.buildAuthHeaders(rawEvent.accountId, rawEvent.connectorType);

    const res = await fetch(fileUrl, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`File download failed: ${res.status} ${res.statusText}`);
    }

    const mime = mimetype.toLowerCase();
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const header = fileName ? `# ${fileName}` : '';

    // Image → Ollama VL model
    if (mime.startsWith('image/')) {
      const [memory] = await this.dbService.db
        .select({ text: memories.text })
        .from(memories)
        .where(eq(memories.id, memoryId));
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const description = await this.ai.generate(photoDescriptionPrompt(memory?.text || ''), [
        base64,
      ]);
      return description.trim() || null;
    }

    // PDF
    if (mime === 'application/pdf' || ext === 'pdf') {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const buffer = Buffer.from(await res.arrayBuffer());
      const data = await (pdfParse as (buf: Buffer) => Promise<{ text?: string }>)(buffer);
      const text = data.text?.trim();
      if (!text) return null;
      let content = header ? `${header}\n\n${text}` : text;
      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }
      return content;
    }

    // DOCX
    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === 'docx'
    ) {
      const mammoth = await import('mammoth');
      const buffer = Buffer.from(await res.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value?.trim();
      if (!text) return null;
      let content = header ? `${header}\n\n${text}` : text;
      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }
      return content;
    }

    // Spreadsheets
    if (
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'text/csv' ||
      ext === 'xlsx' ||
      ext === 'xls' ||
      ext === 'csv'
    ) {
      const XLSX = await import('xlsx');
      const buffer = Buffer.from(await res.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sections: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (!csv.trim()) continue;
        const lines = csv.split('\n').filter((l: string) => l.trim());
        if (!lines.length) continue;
        const mdLines: string[] = [`## ${sheetName}`];
        const headerCols = lines[0].split(',');
        mdLines.push(`| ${headerCols.join(' | ')} |`);
        mdLines.push(`| ${headerCols.map(() => '---').join(' | ')} |`);
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          mdLines.push(`| ${cols.join(' | ')} |`);
        }
        sections.push(mdLines.join('\n'));
      }

      if (!sections.length) return null;
      let content = header ? `${header}\n\n${sections.join('\n\n')}` : sections.join('\n\n');
      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }
      return content;
    }

    // Plain text
    if (mime.startsWith('text/') && ext !== 'csv') {
      const text = await res.text();
      if (!text.trim()) return null;
      let content = header ? `${header}\n\n${text.trim()}` : text.trim();
      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }
      return content;
    }

    return null;
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

  private async linkThread(memoryId: string, threadId: string, connectorType: string) {
    const threadSiblings = await this.dbService.db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.connectorType, connectorType),
          sql`metadata IS NOT NULL AND metadata <> '' AND left(metadata, 1) = '{' AND (metadata::jsonb->>'threadId') = ${threadId}`,
        ),
      )
      .limit(20);
    const siblings = threadSiblings.filter((s) => s.id !== memoryId);
    if (siblings.length) {
      const now = new Date();
      for (const sib of siblings) {
        const existingLink = await this.dbService.db
          .select({ id: memoryLinks.id })
          .from(memoryLinks)
          .where(and(eq(memoryLinks.srcMemoryId, sib.id), eq(memoryLinks.dstMemoryId, memoryId)))
          .limit(1);
        if (!existingLink.length) {
          await this.dbService.db.insert(memoryLinks).values({
            id: randomUUID(),
            srcMemoryId: sib.id,
            dstMemoryId: memoryId,
            linkType: 'related',
            strength: 0.8,
            createdAt: now,
          });
        }
      }
    }
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
    let auth: Record<string, unknown> = {};
    try {
      const account = await this.accountsService.getById(accountId);
      if (account.authContext) auth = JSON.parse(account.authContext) as Record<string, unknown>;
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

  private async buildAuthHeaders(
    accountId: string | null,
    connectorType: string,
  ): Promise<Record<string, string>> {
    if (!accountId) return {};
    let account;
    try {
      account = await this.accountsService.getById(accountId);
    } catch {
      return {};
    }
    const authContext = account.authContext ? JSON.parse(account.authContext) : null;
    if (!authContext?.accessToken) return {};
    switch (connectorType) {
      case 'slack':
        return { Authorization: `Bearer ${authContext.accessToken}` };
      case 'photos':
        return { 'x-api-key': authContext.accessToken };
      default:
        return { Authorization: `Bearer ${authContext.accessToken}` };
    }
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'memory';
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
