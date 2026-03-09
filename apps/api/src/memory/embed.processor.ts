import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { MemoryService } from './memory.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  rawEvents,
  memories,
  memoryLinks,
  settings,
  accounts,
  memoryBanks,
  jobs,
} from '../db/schema';
import { photoDescriptionPrompt } from './prompts';
import { normalizeEntities } from './entity-normalizer';
import type { ConnectorDataEvent, PipelineContext, ConnectorLogger } from '@botmem/connector-sdk';

const MAX_CONTENT_LENGTH = 10_000;
const TRUNCATION_SUFFIX = '\n\n---\n*[Truncated]*';

@Processor('embed')
export class EmbedProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(EmbedProcessor.name);
  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private memoryService: MemoryService,
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private contactsService: ContactsService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private pluginRegistry: PluginRegistry,
    private analytics: AnalyticsService,
    @InjectQueue('enrich') private enrichQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[embed worker] ${err.message}`));
    const concurrency = parseInt(await this.settingsService.get('embed_concurrency'), 10) || 8;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'embed_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 8;
      }
    });
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
    const text = rawEvent.cleanedText || event.content?.text || '';

    if (!text) {
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const metadata = event.content?.metadata || {};
    const attachments = event.content?.attachments;
    if (attachments?.length) {
      metadata.attachments = attachments;
    }

    const ctx = await this.buildPipelineContext(rawEvent.accountId, rawEvent.connectorType);

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[embed:start] ${event.sourceType} ${mid} (${text.length} chars) "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
    );

    const pipelineStart = Date.now();

    // Call connector.embed() for entity extraction
    const embedResult = await connector.embed(event, text, ctx);
    const embedText = embedResult.text || text;

    // Convert embed entities to normalized {type, value} format for metadata persistence
    const embedEntities = normalizeEntities(
      embedResult.entities.map((e) => {
        // Extract human-readable value from compound ID (e.g., "name:John|email:john@x.com")
        const namePart = e.id.split('|').find((p: string) => p.startsWith('name:'));
        const value = namePart ? namePart.slice(5) : e.id.split('|')[0].replace(/^\w+:/, '');
        return { type: e.type, value };
      }),
    );

    // Deterministic ID from rawEventId so retries overwrite the same Qdrant point
    const memoryId = createHash('sha256')
      .update(rawEventId)
      .digest('hex')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
    const now = new Date();
    const mergedMetadata: Record<string, unknown> = {
      ...metadata,
      ...(embedResult.metadata || {}),
      embedEntities,
    };

    // Look up the memory bank: use explicit job-level override, else default bank
    let memoryBankId: string | null = null;
    let ownerUserId: string | null = null;
    try {
      // Check if the parent job specifies a target memory bank
      if (parentJobId) {
        const [parentJob] = await this.dbService.db
          .select({ memoryBankId: jobs.memoryBankId })
          .from(jobs)
          .where(eq(jobs.id, parentJobId));
        if (parentJob?.memoryBankId) {
          memoryBankId = parentJob.memoryBankId;
        }
      }

      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, rawEvent.accountId));
      ownerUserId = acct?.userId || null;

      // Fall back to default bank if no job-level override
      if (!memoryBankId && acct?.userId) {
        const [defaultBank] = await this.dbService.db
          .select({ id: memoryBanks.id })
          .from(memoryBanks)
          .where(and(eq(memoryBanks.userId, acct.userId), eq(memoryBanks.isDefault, true)));
        memoryBankId = defaultBank?.id || null;
      }
    } catch (err) {
      this.logger.warn(
        'Memory bank lookup failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // --- Resolve contacts (create/find) BEFORE inserting memory ---
    let t0 = Date.now();
    let selfContactId: string | null = null;
    const resolvedContacts: Array<{ contactId: string; role: string }> = [];
    try {
      const selfRow = await this.dbService.db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'selfContactId'))
        .limit(1);
      selfContactId = selfRow[0]?.value || null;

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
      }

      // Build avatar lookup maps for this event
      const gmailPhotoUrl =
        rawEvent.connectorType === 'gmail' && event.sourceType === 'contact'
          ? (metadata.photoUrl as string | undefined)
          : undefined;

      const slackProfiles =
        rawEvent.connectorType === 'slack'
          ? ((metadata.participantProfiles || {}) as Record<
              string,
              { avatarUrl?: string; [key: string]: unknown }
            >)
          : {};

      for (const { entityType, role, identifiers } of buckets) {
        const resolveType = entityType === 'person' ? undefined : entityType;
        const contact = await this.contactsService.resolveContact(
          identifiers,
          resolveType as any,
          ownerUserId || undefined,
        );
        if (contact) {
          resolvedContacts.push({ contactId: contact.id, role });

          // Update avatar for Gmail contact events
          if (gmailPhotoUrl) {
            try {
              await this.contactsService.updateAvatar(contact.id, {
                url: gmailPhotoUrl,
                source: 'gmail',
              });
            } catch (err) {
              this.logger.warn(
                `[embed] Gmail avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Update avatar for Slack — find the matching profile by slack_id key
          if (rawEvent.connectorType === 'slack' && Object.keys(slackProfiles).length > 0) {
            // The entity ID for slack participants starts with slack_id:<username>
            const slackIdent = identifiers.find((i) => i.type === 'slack_id');
            if (slackIdent) {
              const profile = slackProfiles[slackIdent.value];
              const avatarUrl = profile?.avatarUrl as string | undefined;
              if (avatarUrl) {
                try {
                  await this.contactsService.updateAvatar(contact.id, {
                    url: avatarUrl,
                    source: 'slack',
                  });
                } catch (err) {
                  this.logger.warn(
                    `[embed] Slack avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(
        'Contact resolution failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
    const contactMs = Date.now() - t0;

    // --- Generate embedding + store in Qdrant (before DB insert) ---
    const maxChars = 6000;
    let currentText = embedText;
    const truncatedText =
      currentText.length > maxChars ? currentText.slice(0, maxChars) : currentText;

    t0 = Date.now();
    let vector = await this.ollama.embed(truncatedText);
    const embedMs = Date.now() - t0;

    t0 = Date.now();
    await this.qdrant.upsert(memoryId, vector, {
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
      event_time: event.timestamp,
      account_id: rawEvent.accountId,
      memory_bank_id: memoryBankId,
    });
    const qdrantMs = Date.now() - t0;

    // File processing (image → VL model description → re-embed)
    if (mergedMetadata.fileUrl && (mergedMetadata.mimetype as string)?.startsWith('image/')) {
      try {
        const fileContent = await this.processFile(memoryId, mergedMetadata, rawEvent);
        if (fileContent) {
          currentText = fileContent + '\n\n' + currentText;
          const reEmbedText =
            currentText.length > maxChars ? currentText.slice(0, maxChars) : currentText;
          vector = await this.ollama.embed(reEmbedText);
          await this.qdrant.upsert(memoryId, vector, {
            source_type: event.sourceType,
            connector_type: rawEvent.connectorType,
            event_time: event.timestamp,
            account_id: rawEvent.accountId,
            memory_bank_id: memoryBankId,
          });
        }
      } catch (err: any) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[embed:file] ${mid} file processing failed: ${err?.message}`,
        );
      }
    }

    // --- All external work succeeded — insert plaintext; enrich processor encrypts at end of pipeline ---
    const metadataStr = JSON.stringify(mergedMetadata);

    t0 = Date.now();
    if (ownerUserId) {
      // Wrap memory insert in RLS scope so policy allows INSERT (account.user_id must match session var)
      await this.dbService.withUserId(ownerUserId, (db) =>
        db
          .insert(memories)
          .values({
            id: memoryId,
            accountId: rawEvent.accountId,
            memoryBankId,
            connectorType: rawEvent.connectorType,
            sourceType: event.sourceType,
            sourceId: event.sourceId,
            text: currentText,
            eventTime: new Date(event.timestamp),
            ingestTime: now,
            metadata: metadataStr,
            embeddingStatus: 'pending',
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: memories.id,
            set: { text: currentText, metadata: metadataStr, embeddingStatus: 'pending' },
          }),
      );
    } else {
      // No ownerUserId — unscoped insert (orphaned account, should rarely happen)
      await this.dbService.db
        .insert(memories)
        .values({
          id: memoryId,
          accountId: rawEvent.accountId,
          memoryBankId,
          connectorType: rawEvent.connectorType,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          text: currentText,
          eventTime: new Date(event.timestamp),
          ingestTime: now,
          metadata: metadataStr,
          embeddingStatus: 'pending',
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: memories.id,
          set: { text: currentText, metadata: metadataStr, embeddingStatus: 'pending' },
        });
    }
    const dbInsertMs = Date.now() - t0;

    // Link contacts + threads now that memory row exists
    let contactCount = 0;
    if (selfContactId) {
      await this.contactsService.linkMemory(memoryId, selfContactId, 'participant');
      contactCount++;
    }
    for (const { contactId, role } of resolvedContacts) {
      await this.contactsService.linkMemory(memoryId, contactId, role);
      contactCount++;
    }

    // Thread linking from entities
    for (const entity of embedResult.entities) {
      if (entity.type === 'message' && entity.id.startsWith('thread:')) {
        try {
          await this.linkThread(
            memoryId,
            entity.id.replace('thread:', ''),
            rawEvent.connectorType,
            ownerUserId ?? undefined,
          );
        } catch (err) {
          this.logger.warn(
            'Thread linking failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    if (mergedMetadata.threadId) {
      try {
        await this.linkThread(
          memoryId,
          mergedMetadata.threadId as string,
          rawEvent.connectorType,
          ownerUserId ?? undefined,
        );
      } catch (err) {
        this.logger.warn('Thread linking failed', err instanceof Error ? err.message : String(err));
      }
    }

    // Fire hooks (fire-and-forget)
    void this.pluginRegistry.fireHook('afterIngest', {
      id: memoryId,
      text: embedText,
      sourceType: event.sourceType,
      connectorType: rawEvent.connectorType,
      eventTime: new Date(event.timestamp),
    });
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
      `[embed:done] ${memoryId.slice(0, 8)} in ${Date.now() - pipelineStart}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) ollama=${embedMs}ms(${vector.length}d) qdrant=${qdrantMs}ms`,
    );

    this.analytics.capture('embed_complete', {
      memory_id: memoryId,
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
    });

    // Enqueue to enrich stage or finalize
    const pipelineEnrich = connector.manifest.pipeline?.enrich !== false;
    if (pipelineEnrich) {
      await this.enrichQueue.add(
        'enrich',
        { rawEventId, memoryId },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    } else {
      // Mark memory done in RLS scope (or unscoped if no owner)
      const updateDone = (db: typeof this.dbService.db) =>
        db.update(memories).set({ embeddingStatus: 'done' }).where(eq(memories.id, memoryId));
      if (ownerUserId) {
        await this.dbService.withUserId(ownerUserId, updateDone);
      } else {
        await updateDone(this.dbService.db);
      }
      this.events.emitToChannel('memories', 'memory:updated', {
        memoryId,
        sourceType: event.sourceType,
        connectorType: rawEvent.connectorType,
        text: currentText.slice(0, 100),
      });
      this.emitGraphDelta(memoryId);
      await this.advanceAndComplete(parentJobId);
    }
  }

  private async processFile(
    memoryId: string,
    metadata: Record<string, any>,
    rawEvent: any,
  ): Promise<string | null> {
    const fileUrl: string = metadata.fileUrl;
    const mimetype: string = metadata.mimetype || '';
    const fileName: string = metadata.fileName || '';
    const mid = memoryId.slice(0, 8);

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[embed:file] ${mid} "${fileName || 'unknown'}" (${mimetype || 'unknown'})`,
    );

    const headers = await this.buildAuthHeaders(rawEvent.accountId, rawEvent.connectorType);

    // Use thumbnail size for images to speed up VL model processing
    const fetchUrl = mimetype.startsWith('image/')
      ? fileUrl.replace('size=preview', 'size=thumbnail').replace('size=original', 'size=thumbnail')
      : fileUrl;

    const res = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`File download failed: ${res.status} ${res.statusText}`);
    }

    const mime = mimetype.toLowerCase();
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const header = fileName ? `# ${fileName}` : '';

    if (mime.startsWith('image/')) {
      // processFile runs inside process() after ownerUserId is resolved — use unscoped read
      // since this is a read-only lookup for VL model context and the memory was just inserted above
      const [memory] = await this.dbService.db
        .select({ text: memories.text })
        .from(memories)
        .where(eq(memories.id, memoryId));
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const description = await this.ollama.generate(photoDescriptionPrompt(memory?.text || ''), [
        base64,
      ]);
      return description.trim() || null;
    }

    if (mime === 'application/pdf' || ext === 'pdf') {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const buffer = Buffer.from(await res.arrayBuffer());
      const data = await (pdfParse as any)(buffer);
      const text = data.text?.trim();
      if (!text) return null;
      let content = header ? `${header}\n\n${text}` : text;
      if (content.length > MAX_CONTENT_LENGTH) {
        content =
          content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }
      return content;
    }

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

  private async linkThread(
    memoryId: string,
    threadId: string,
    connectorType: string,
    ownerUserId?: string,
  ) {
    // Use withUserId scope if available so memory_links RLS policy is satisfied
    const doLink = async (db: typeof this.dbService.db) => {
      const threadSiblings = await db
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
          const existingLink = await db
            .select({ id: memoryLinks.id })
            .from(memoryLinks)
            .where(and(eq(memoryLinks.srcMemoryId, sib.id), eq(memoryLinks.dstMemoryId, memoryId)))
            .limit(1);
          if (!existingLink.length) {
            await db.insert(memoryLinks).values({
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
    };
    if (ownerUserId) {
      await this.dbService.withUserId(ownerUserId, doLink);
    } else {
      await doLink(this.dbService.db);
    }
  }

  private emitGraphDelta(memoryId: string) {
    this.memoryService
      .buildGraphDelta(memoryId)
      .then((delta) => {
        if (delta) this.events.emitToChannel('memories', 'graph:delta', delta);
      })
      .catch(() => {});
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
    } catch (err) {
      this.logger.warn(
        'Job progress advance failed',
        err instanceof Error ? err.message : String(err),
      );
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
    } catch (err) {
      this.logger.warn(
        'Auth context parse failed',
        err instanceof Error ? err.message : String(err),
      );
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
    const stage = 'embed';
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
