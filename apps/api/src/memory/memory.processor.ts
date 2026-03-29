import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AiService } from './ai.service';
import { TypesenseService } from './typesense.service';
import { MemoryService } from './memory.service';
import { EnrichService } from './enrich.service';
import { ContentCleaner } from './content-cleaner';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { PeopleService, IdentifierInput } from '../people/people.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { AnalyticsService } from '../analytics/analytics.service';
import { ConfigService } from '../config/config.service';
import { GeoService } from '../geo/geo.service';
import { QuotaService } from '../billing/quota.service';
import {
  rawEvents,
  memories,
  memoryLinks,
  settings,
  accounts,
  memoryBanks,
  jobs,
} from '../db/schema';
import { normalizeEntities } from './entity-normalizer';
import { TraceContext, generateTraceId, generateSpanId } from '../tracing/trace.context';
import { Traced } from '../tracing/traced.decorator';
import type { ConnectorDataEvent, PipelineContext, ConnectorLogger } from '@botmem/connector-sdk';

/** Strip PostgreSQL-incompatible null bytes from strings */
function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x00/g, '');
}

@Processor('memory')
export class MemoryProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MemoryProcessor.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private ai: AiService,
    private typesense: TypesenseService,
    private memoryService: MemoryService,
    private enrichService: EnrichService,
    private contentCleaner: ContentCleaner,
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private contactsService: PeopleService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private pluginRegistry: PluginRegistry,
    private analytics: AnalyticsService,
    private config: ConfigService,
    private geo: GeoService,
    private quotaService: QuotaService,
    private traceContext: TraceContext,
    @InjectQueue('memory') private memoryQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[memory worker] ${err.message}`));
    this.worker.on('failed', (job, err) => this.onJobFailed(job, err));
    const defaultC = this.config.aiConcurrency.embed;
    const concurrency =
      parseInt(await this.settingsService.get('memory_concurrency'), 10) || defaultC;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'memory_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultC;
      }
    });

    // Drain old queues: migrate remaining jobs to unified memory queue
    this.drainOldQueues().catch((err) =>
      this.logger.warn(`[drain] Failed to migrate old queue jobs: ${err.message}`),
    );
  }

  /** Migrate remaining jobs from old clean/embed/enrich queues to the unified memory queue. */
  private async drainOldQueues() {
    const redisUrl = this.config.redisUrl;
    for (const queueName of ['clean', 'embed', 'enrich']) {
      try {
        const oldQueue = new Queue(queueName, {
          connection: { url: redisUrl, maxRetriesPerRequest: null },
        });
        const waiting = await oldQueue.getWaiting();
        const delayed = await oldQueue.getDelayed();
        const remaining = [...waiting, ...delayed];
        if (remaining.length > 0) {
          this.logger.log(`Migrating ${remaining.length} jobs from ${queueName} to memory queue`);
          for (const job of remaining) {
            await this.memoryQueue.add('process', job.data, {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
            });
            await job.remove();
          }
        }
        await oldQueue.close();
      } catch {
        // Queue doesn't exist or is empty, skip
      }
    }
  }

  private async onJobFailed(job: Job | undefined, err: Error) {
    if (!job) return;
    const { rawEventId } = job.data;
    const mid = rawEventId?.slice(0, 8) || '?';
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isLastAttempt) return;

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
          `[memory:failed] ${mid} exhausted ${job.attemptsMade} retries: ${err.message}`,
          raw.jobId,
        );
      }
    } catch {
      this.logger.warn(`[memory:failed] ${mid}: ${err.message}`);
    }
  }

  async process(job: Job<{ rawEventId: string; _trace?: { traceId: string; spanId: string } }>) {
    const trace = job.data._trace;
    const traceId = trace?.traceId || generateTraceId();
    const spanId = generateSpanId();
    return this.traceContext.run({ traceId, spanId }, () => this._process(job));
  }

  @Traced('memory.process')
  private async _process(
    job: Job<{ rawEventId: string; _trace?: { traceId: string; spanId: string } }>,
  ) {
    const { rawEventId } = job.data;
    const currentTrace = this.traceContext.current()!;
    void currentTrace; // used in future trace propagation

    // 1. Load raw event from DB
    const rows = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    if (!rows.length) return;
    const rawEvent = rows[0];
    const parentJobId = rawEvent.jobId;
    const mid = rawEventId.slice(0, 8);

    this.traceContext.set({
      jobId: parentJobId ?? undefined,
      connectorType: rawEvent.connectorType,
    });

    const event: ConnectorDataEvent = JSON.parse(
      this.crypto.decrypt(rawEvent.payload) || rawEvent.payload,
    );
    const connector = this.connectors.get(rawEvent.connectorType);

    // Skip contact/group events — these are handled by PeopleService, not as memories
    if ((event.sourceType as string) === 'contact' || (event.sourceType as string) === 'group') {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'debug',
        `[memory:skip] ${mid} sourceType=${event.sourceType} — not a memory`,
        parentJobId,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // 2. Parse text — use cleaned text from clean stage if available
    const text =
      (rawEvent.cleanedText
        ? this.crypto.decrypt(rawEvent.cleanedText) || rawEvent.cleanedText
        : '') ||
      event.content?.text ||
      '';

    if (!text) {
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const metadata = event.content?.metadata || {};
    const attachments = event.content?.attachments;
    if (attachments?.length) {
      metadata.attachments = attachments;
    }

    const ctx = await this.buildPipelineContext(
      rawEvent.accountId,
      rawEvent.connectorType,
      parentJobId,
    );

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[memory:start] ${event.sourceType} ${mid} (${text.length} chars) "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
      parentJobId,
    );

    const pipelineStart = Date.now();

    // Call connector.embed() for entity extraction
    const embedResult = await connector.embed(event, text, ctx);
    let embedText = embedResult.text || text;

    // Convert embed entities to normalized {type, value} format
    const embedEntities = normalizeEntities(
      embedResult.entities.map((e) => {
        const namePart = e.id.split('|').find((p: string) => p.startsWith('name:'));
        const value = namePart ? namePart.slice(5) : e.id.split('|')[0].replace(/^\w+:/, '');
        return { type: e.type, value };
      }),
    );

    // Deterministic ID from rawEventId so retries overwrite the same record
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

    // Geocode locations
    const metaLat = metadata.lat as number | undefined;
    const metaLon = metadata.lon as number | undefined;
    if (metaLat != null && metaLon != null) {
      try {
        const geoResult = await this.geo.reverseGeocode(metaLat, metaLon);
        if (geoResult.city) {
          const addressParts = [geoResult.city, geoResult.state, geoResult.country].filter(Boolean);
          const addressStr = addressParts.join(', ');
          embedText = `At ${addressStr} [${metaLat.toFixed(5)}, ${metaLon.toFixed(5)}] — ${embedText}`;
          mergedMetadata.city = geoResult.city;
          mergedMetadata.state = geoResult.state;
          mergedMetadata.country = geoResult.country;
          mergedMetadata.countryCode = geoResult.countryCode;
        }
      } catch (geoErr) {
        this.logger.debug(
          `[memory:geo] ${mid} geocode failed: ${geoErr instanceof Error ? geoErr.message : String(geoErr)}`,
        );
      }
    }

    // 4. Apply ContentCleaner
    embedText = this.contentCleaner.cleanText(embedText, event.sourceType, rawEvent.connectorType);
    if (!embedText) {
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // Look up memory bank
    let memoryBankId: string | null = null;
    let ownerUserId: string | null = null;
    try {
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

    // Dedup check
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
        parentJobId,
      );
      await this.advanceAndComplete(parentJobId);
      return;
    }

    // 5. Resolve contacts
    let t0 = Date.now();
    let selfContactId: string | null = null;
    const resolvedContacts: Array<{ contactId: string; role: string; name?: string }> = [];
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
        if (
          entity.type === 'person' ||
          entity.type === 'group' ||
          entity.type === 'device' ||
          entity.type === 'organization'
        ) {
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

      // Avatar lookup maps
      const gmailPhotoUrl =
        rawEvent.connectorType === 'gmail' && (event.sourceType as string) === 'contact'
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
        const contact = await Promise.race([
          this.contactsService.resolvePerson(
            identifiers,
            resolveType as 'group' | 'organization' | 'device' | undefined,
            ownerUserId || undefined,
          ),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('Contact resolution timed out after 30s')), 30_000),
          ),
        ]).catch((err) => {
          this.logger.warn(
            `[memory] Contact resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        });
        if (contact) {
          const nameIdent = identifiers.find((i) => i.type === 'name');
          resolvedContacts.push({ contactId: contact.id, role, name: nameIdent?.value });

          // Gmail avatar
          if (gmailPhotoUrl) {
            try {
              await this.contactsService.updateAvatar(contact.id, {
                url: gmailPhotoUrl,
                source: 'gmail',
              });
            } catch (err) {
              this.logger.warn(
                `[memory] Gmail avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Slack avatar
          if (rawEvent.connectorType === 'slack' && Object.keys(slackProfiles).length > 0) {
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
                    `[memory] Slack avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }
          }

          // Immich avatar
          if (rawEvent.connectorType === 'photos') {
            const immichPeople =
              (metadata.people as Array<{ name?: string; thumbnailUrl?: string }>) || [];
            const nameId = identifiers.find((i) => i.type === 'name');
            const matchedPerson = nameId
              ? immichPeople.find(
                  (p) => p.name && p.name.toLowerCase() === nameId.value.toLowerCase(),
                )
              : undefined;
            if (matchedPerson?.thumbnailUrl) {
              try {
                const immichHeaders = await this.buildAuthHeaders(rawEvent.accountId, 'photos');
                await this.contactsService.updateAvatar(
                  contact.id,
                  { url: matchedPerson.thumbnailUrl, source: 'immich' },
                  immichHeaders,
                );
              } catch (err) {
                this.logger.warn(
                  `[memory] Immich avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
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

    // 3. File processing — parse file content
    const hasFile = mergedMetadata.fileUrl || mergedMetadata.fileBase64;
    const fileMime = (mergedMetadata.mimetype as string) || '';
    let currentText = embedText;

    if (hasFile && !fileMime.startsWith('image/')) {
      // Non-image files: parse via ContentCleaner
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);
        const fileContent = await this.contentCleaner.parseFile(
          fileBuffer,
          fileMime,
          mergedMetadata.fileName as string | undefined,
        );
        if (fileContent) {
          currentText = fileContent + '\n\n' + currentText;
        }
      } catch (err: unknown) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:file] ${mid} file processing failed: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
      }
    }

    // Image files: store thumbnail, no VL description generation
    if (hasFile && fileMime.startsWith('image/')) {
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);
        if (fileBuffer.length <= 30_000) {
          mergedMetadata.thumbnailBase64 = fileBuffer.toString('base64');
        }
      } catch (err: unknown) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:thumbnail] ${mid} thumbnail failed: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
      }
    }

    // 7. Generate embedding
    const maxChars = 6000;
    const truncatedText =
      currentText.length > maxChars ? currentText.slice(0, maxChars) : currentText;

    t0 = Date.now();
    let vector: number[];

    const isGeminiMultimodal = this.config.embedBackend === 'gemini';
    const canMultimodal =
      isGeminiMultimodal &&
      hasFile &&
      (fileMime.startsWith('image/') || fileMime === 'application/pdf');

    if (canMultimodal) {
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);

        // For PDFs on Gemini path, still extract text for display
        if (fileMime === 'application/pdf') {
          const pdfText = await this.contentCleaner.parseFile(fileBuffer, fileMime);
          if (pdfText) {
            currentText = pdfText + '\n\n' + currentText;
          }
        }

        const parts: import('./gemini-embed.service').EmbedPart[] = [
          {
            type: fileMime.startsWith('image/') ? 'image' : 'pdf',
            base64: fileBuffer.toString('base64'),
            mimeType: fileMime,
          },
          { type: 'text', text: currentText },
        ];
        vector = await this.ai.embedMultimodal(parts);
      } catch (err: unknown) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:multimodal] ${mid} Gemini embed failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
        vector = await this.ai.embed(truncatedText);
      }
    } else {
      vector = await this.ai.embed(truncatedText);
    }
    const embedMs = Date.now() - t0;

    // Upsert to Typesense
    t0 = Date.now();
    const peopleNames = resolvedContacts.map((c) => c.name).filter(Boolean) as string[];
    const typesensePayload: Record<string, unknown> = {
      text: truncatedText,
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
      event_time: event.timestamp,
      account_id: rawEvent.accountId,
      memory_bank_id: memoryBankId,
      people: peopleNames,
    };
    await this.typesense.upsert(memoryId, vector, typesensePayload);
    const typesenseMs = Date.now() - t0;

    // 8. Enrich inline (best-effort)
    let enrichEntities: Array<{ type: string; value: string }> = [];
    let enrichFactuality: { label: string; confidence: number; rationale: string } | null = null;
    try {
      const enrichResult = await this.enrichService.enrichInline({
        text: currentText,
        sourceType: event.sourceType,
        connectorType: rawEvent.connectorType,
        metadata: mergedMetadata,
      });
      enrichEntities = enrichResult.entities;
      enrichFactuality = enrichResult.factuality;
    } catch (err: unknown) {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'warn',
        `[memory:enrich] ${mid} inline enrichment failed: ${err instanceof Error ? err.message : String(err)}`,
        parentJobId,
      );
    }

    // Compute weights
    const ageDays = (Date.now() - new Date(event.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-0.015 * ageDays);
    const importance = 0.5 + Math.min(enrichEntities.length * 0.1, 0.4);
    const trust = this.getTrustScore(rawEvent.connectorType);
    const weights = { semantic: 0, rerank: 0, recency, importance, trust, final: 0 };

    // 9. Encrypt all fields (single pass)
    currentText = stripNullBytes(currentText);
    const metadataStr = stripNullBytes(JSON.stringify(mergedMetadata));

    // Quota check
    if (ownerUserId) {
      const quota = await this.quotaService.canCreateMemory(ownerUserId);
      if (!quota.allowed) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:quota] Skipped — reached ${quota.limit} memory limit (free plan).`,
          parentJobId,
        );
        await this.advanceAndComplete(parentJobId);
        return;
      }
    }

    let insertText = currentText;
    let insertMetadata = metadataStr;

    if (ownerUserId) {
      const userKey = await this.userKeyService.getDek(ownerUserId);
      if (!userKey) {
        throw new Error('User key not available. Submit recovery key to unlock encryption.');
      }

      const enc = this.crypto.encryptMemoryFieldsWithKey(
        { text: currentText, entities: '', claims: '', metadata: metadataStr },
        userKey,
      );
      insertText = enc.text;
      insertMetadata = enc.metadata;
    }

    // 6. Create memory record with pipelineComplete=true
    t0 = Date.now();
    const factualityJson = enrichFactuality ? JSON.stringify(enrichFactuality) : null;

    if (ownerUserId) {
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
            text: insertText,
            eventTime: new Date(event.timestamp),
            ingestTime: now,
            metadata: insertMetadata,
            entities: enrichEntities.length ? JSON.stringify(enrichEntities) : '[]',
            factuality: factualityJson
              ? this.crypto.encrypt(factualityJson)!
              : '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}',
            factualityLabel: enrichFactuality?.label || 'UNVERIFIED',
            weights: weights as Record<string, number>,
            embeddingStatus: 'done',
            pipelineComplete: true,
            createdAt: now,
          })
          .onConflictDoNothing({ target: [memories.sourceId, memories.connectorType] }),
      );
      // 10. Compute search_tokens from plaintext
      await this.dbService.withUserId(ownerUserId, (db) =>
        db
          .update(memories)
          .set({ searchTokens: sql`to_tsvector('english', ${currentText})` })
          .where(eq(memories.id, memoryId)),
      );
    } else {
      await this.dbService.db
        .insert(memories)
        .values({
          id: memoryId,
          accountId: rawEvent.accountId,
          memoryBankId,
          connectorType: rawEvent.connectorType,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          text: insertText,
          eventTime: new Date(event.timestamp),
          ingestTime: now,
          metadata: insertMetadata,
          entities: enrichEntities.length ? JSON.stringify(enrichEntities) : '[]',
          factuality: factualityJson
            ? this.crypto.encrypt(factualityJson)!
            : '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}',
          factualityLabel: enrichFactuality?.label || 'UNVERIFIED',
          weights: weights as Record<string, number>,
          embeddingStatus: 'done',
          pipelineComplete: true,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [memories.sourceId, memories.connectorType] });
      await this.dbService.db
        .update(memories)
        .set({ searchTokens: sql`to_tsvector('english', ${currentText})` })
        .where(eq(memories.id, memoryId));
    }
    const dbInsertMs = Date.now() - t0;

    // Bump quota cache
    if (ownerUserId) {
      this.quotaService.incrementCachedCount(ownerUserId);
    }

    // Link contacts + threads
    let contactCount = 0;
    if (selfContactId) {
      await this.contactsService.linkMemory(memoryId, selfContactId, 'participant');
      contactCount++;
    }
    for (const { contactId, role } of resolvedContacts) {
      await this.contactsService.linkMemory(memoryId, contactId, role);
      contactCount++;
    }

    // Thread linking
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
          this.logger.debug(
            `Thread linking skipped: ${err instanceof Error ? err.message : String(err)}`,
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

    // 12. Create links (best-effort)
    try {
      await this.createLinks(memoryId);
    } catch {
      // Link creation is best-effort
    }

    // Fire hooks
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

    // Emit memory updated event
    this.events.emitToChannel('memories', 'memory:updated', {
      memoryId,
      sourceType: event.sourceType,
      connectorType: rawEvent.connectorType,
      text: currentText.slice(0, 100),
    });
    this.emitGraphDelta(memoryId);

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[memory:done] ${memoryId.slice(0, 8)} in ${Date.now() - pipelineStart}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) embed=${embedMs}ms(${vector.length}d) typesense=${typesenseMs}ms entities=${enrichEntities.length} fact=${enrichFactuality?.label || 'UNVERIFIED'}`,
      parentJobId,
    );

    this.analytics.capture('memory_complete', {
      memory_id: memoryId,
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
    });

    // Advance parent job progress
    await this.advanceAndComplete(parentJobId);
  }

  private getTrustScore(connectorType: string): number {
    try {
      return this.connectors.get(connectorType).manifest.trustScore;
    } catch {
      return 0.7;
    }
  }

  private async getFileBuffer(
    metadata: Record<string, unknown>,
    rawEvent: { accountId: string; connectorType: string },
  ): Promise<Buffer> {
    const fileBase64 = (metadata.fileBase64 as string) || '';
    if (fileBase64) return Buffer.from(fileBase64, 'base64');

    const fileUrl = (metadata.fileUrl as string) || '';
    const mimetype = (metadata.mimetype as string) || '';
    const headers = await this.buildAuthHeaders(rawEvent.accountId, rawEvent.connectorType);
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
    return Buffer.from(await res.arrayBuffer());
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
    _ownerUserId?: string,
  ) {
    const db = this.dbService.db;
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
    if (!siblings.length) return;
    const now = new Date();
    for (const sib of siblings) {
      try {
        await db
          .insert(memoryLinks)
          .values({
            id: randomUUID(),
            srcMemoryId: sib.id,
            dstMemoryId: memoryId,
            linkType: 'related',
            strength: 0.8,
            createdAt: now,
          })
          .onConflictDoNothing();
      } catch {
        // FK violation — sibling not yet committed; skip
      }
    }
  }

  private async createLinks(memoryId: string): Promise<void> {
    const SIMILARITY_THRESHOLD = 0.8;
    const SIMILAR_MEMORY_LIMIT = 5;

    const results = await this.typesense.recommend(memoryId, SIMILAR_MEMORY_LIMIT);
    const candidates = results.filter((r) => r.score >= SIMILARITY_THRESHOLD && r.id !== memoryId);
    if (!candidates.length) return;

    const candidateIds = candidates.map((c) => c.id);
    const existingLinks = await this.dbService.db
      .select({ srcMemoryId: memoryLinks.srcMemoryId, dstMemoryId: memoryLinks.dstMemoryId })
      .from(memoryLinks)
      .where(
        sql`(${memoryLinks.srcMemoryId} = ${memoryId} AND ${memoryLinks.dstMemoryId} IN (${sql.join(
          candidateIds.map((id) => sql`${id}`),
          sql`, `,
        )}))
         OR (${memoryLinks.dstMemoryId} = ${memoryId} AND ${memoryLinks.srcMemoryId} IN (${sql.join(
           candidateIds.map((id) => sql`${id}`),
           sql`, `,
         )}))`,
      );

    const linkedPairs = new Set(existingLinks.map((l) => `${l.srcMemoryId}::${l.dstMemoryId}`));

    for (const result of candidates) {
      if (
        linkedPairs.has(`${memoryId}::${result.id}`) ||
        linkedPairs.has(`${result.id}::${memoryId}`)
      ) {
        continue;
      }

      await this.dbService.db.insert(memoryLinks).values({
        id: randomUUID(),
        srcMemoryId: memoryId,
        dstMemoryId: result.id,
        linkType: 'related',
        strength: result.score,
        createdAt: new Date(),
      });
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
    jobId?: string | null,
  ): Promise<PipelineContext> {
    let auth: Record<string, unknown> = {};
    try {
      const account = await this.accountsService.getById(accountId);
      if (account.authContext) auth = JSON.parse(account.authContext) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(
        'Auth context parse failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    const logger: ConnectorLogger = {
      info: (msg) => this.addLog(connectorType, accountId, 'info', msg, jobId),
      warn: (msg) => this.addLog(connectorType, accountId, 'warn', msg, jobId),
      error: (msg) => this.addLog(connectorType, accountId, 'error', msg, jobId),
      debug: (msg) => this.addLog(connectorType, accountId, 'debug', msg, jobId),
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

  private addLog(
    connectorType: string,
    accountId: string | null,
    level: string,
    message: string,
    jobId?: string | null,
  ) {
    const stage = 'memory';
    this.logsService.add({
      jobId: jobId ?? undefined,
      connectorType,
      accountId: accountId ?? undefined,
      stage,
      level,
      message,
    });
  }
}
