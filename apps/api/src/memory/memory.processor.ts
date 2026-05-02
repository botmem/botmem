import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AiService } from './ai.service';
import { MEMORY_INDEX_SCHEMA_VERSION, PgSearchService } from './pg-search.service';
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
import {
  buildWhatsAppGroupIdentity,
  shouldMergeEntityResolutionBucket,
} from './connector-normalizers/whatsapp-group-identity';
import { TraceContext, generateTraceId, generateSpanId } from '../tracing/trace.context';
import { Traced } from '../tracing/traced.decorator';
import type {
  ConnectorDataEvent,
  EmbedResult,
  PipelineContext,
  ConnectorLogger,
} from '@botmem/connector-sdk';

type RawEventProcessingState =
  | 'pending'
  | 'memory_created'
  | 'contact_processed'
  | 'identity_processed'
  | 'skipped_contact'
  | 'skipped_empty'
  | 'deduped'
  | 'failed';

type LoadedRawEvent = typeof rawEvents.$inferSelect;

/** Strip PostgreSQL-incompatible null bytes from strings */
function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x00/g, '');
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactStrings(values: unknown[]): string[] {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'file' | 'unknown';

interface PrimaryMedia {
  kind: MediaKind;
  mimeType: string;
  fileName?: string;
  hasInlineContent: boolean;
  hasFetchableUrl: boolean;
}

const MAX_MEDIA_TEXT_CHARS = 8_000;
const MAX_IMAGE_DESCRIPTION_BYTES = 12 * 1024 * 1024;

function normalizeMimeType(value: unknown): string {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function mediaKindFromMime(
  mimeType: string,
  messageType?: unknown,
  sourceType?: unknown,
): MediaKind {
  const type = String(messageType || sourceType || '').toLowerCase();
  if (type === 'image' || mimeType.startsWith('image/')) return 'image';
  if (type === 'audio' || mimeType.startsWith('audio/')) return 'audio';
  if (type === 'video' || mimeType.startsWith('video/')) return 'video';
  if (type === 'document' || sourceType === 'file') return 'document';
  if (mimeType) return 'file';
  return 'unknown';
}

function truncateMediaText(value: string): string {
  const cleaned = value.trim();
  return cleaned.length > MAX_MEDIA_TEXT_CHARS
    ? `${cleaned.slice(0, MAX_MEDIA_TEXT_CHARS)}\n[truncated]`
    : cleaned;
}

@Processor('memory', {
  lockDuration: 900_000,
  lockRenewTime: 300_000,
  stalledInterval: 120_000,
  maxStalledCount: 3,
})
export class MemoryProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MemoryProcessor.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private ai: AiService,
    private searchIndex: PgSearchService,
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
    const defaultC = this.config.aiConcurrency.memory;
    const concurrency =
      parseInt(await this.settingsService.get('memory_concurrency'), 10) || defaultC;
    this.worker.concurrency = concurrency;
    this.settingsService.onChange((key, value) => {
      if (key === 'memory_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultC;
      }
    });

    // Drain old queues: migrate remaining legacy work to unified memory queue.
    this.drainOldQueues().catch((err) =>
      this.logger.warn(`[drain] Failed to migrate old queue jobs: ${err.message}`),
    );
  }

  /** Migrate remaining jobs from old embed/enrich queues to the unified memory queue. */
  private async drainOldQueues() {
    const redisUrl = this.config.redisUrl;
    for (const queueName of ['embed', 'enrich']) {
      try {
        const oldQueue = new Queue(queueName, {
          connection: { url: redisUrl, maxRetriesPerRequest: null },
        });
        const remaining = await oldQueue.getJobs(
          ['waiting', 'delayed', 'failed', 'active'],
          0,
          999,
        );
        let migrated = 0;
        for (const job of remaining) {
          const rawEventId =
            typeof job.data?.rawEventId === 'string'
              ? job.data.rawEventId
              : typeof job.data?.raw_event_id === 'string'
                ? job.data.raw_event_id
                : null;
          if (!rawEventId) continue;
          await this.memoryQueue.add(
            'process',
            { rawEventId },
            {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              jobId: `legacy:${queueName}:${rawEventId}`,
            },
          );
          migrated++;
          try {
            await job.remove();
          } catch (err) {
            this.logger.warn(
              `[drain] Re-enqueued ${queueName} job ${job.id} but could not remove legacy entry: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (migrated > 0) {
          this.logger.log(`Migrated ${migrated} raw event(s) from legacy ${queueName} queue`);
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
    if (!rawEventId) return;
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
        await this.markRawEventState(rawEventId, 'failed');
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
    event.sourceId = rawEvent.sourceId;
    const connector = this.connectors.get(rawEvent.connectorType);
    const metadata = (event.content?.metadata || {}) as Record<string, unknown>;

    if (
      rawEvent.connectorType === 'whatsapp' &&
      (rawEvent.sourceId.startsWith('wa-group:') || event.sourceId.startsWith('wa-group:'))
    ) {
      await this.processWhatsAppGroupIdentityEvent(rawEvent, event, rawEventId, parentJobId, mid);
      return;
    }

    // Most connector contact/group events are metadata only. Gmail contact events
    // are the exception: their connector embed step turns Google Contacts fields
    // into person identifiers (email, phone, names) and organization links.
    // Also skip legacy WhatsApp metadata rows that were emitted as sourceType=message.
    if (
      ((event.sourceType as string) === 'contact' && rawEvent.connectorType !== 'gmail') ||
      (event.sourceType as string) === 'group' ||
      (rawEvent.connectorType === 'whatsapp' &&
        (rawEvent.sourceId.startsWith('wa-contact:') ||
          rawEvent.sourceId.startsWith('wa-group:') ||
          event.sourceId.startsWith('wa-contact:') ||
          event.sourceId.startsWith('wa-group:') ||
          (event.content?.metadata as Record<string, unknown> | undefined)?.type === 'contact')) ||
      (rawEvent.connectorType === 'telegram' && event.sourceId.startsWith('telegram:contact:'))
    ) {
      this.addLog(
        rawEvent.connectorType,
        rawEvent.accountId,
        'debug',
        `[memory:skip] ${mid} sourceType=${event.sourceType} — not a memory`,
        parentJobId,
      );
      await this.markRawEventState(rawEventId, 'skipped_contact');
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
      await this.markRawEventState(rawEventId, 'skipped_empty');
      await this.advanceAndComplete(parentJobId);
      return;
    }

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
      `[memory:start] ${event.sourceType} ${mid} (${text.length} chars)`,
      parentJobId,
    );

    const pipelineStart = Date.now();

    // Call connector.embed() for entity extraction
    const embedResult = await connector.embed(event, text, ctx);
    let embedText = embedResult.text || text;

    if (rawEvent.connectorType === 'gmail' && (event.sourceType as string) === 'contact') {
      await this.processGmailContactIdentityEvent(
        rawEvent,
        event,
        embedResult,
        metadata as Record<string, unknown>,
        rawEventId,
        parentJobId,
        mid,
      );
      return;
    }

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
      await this.markRawEventState(rawEventId, 'skipped_empty');
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
      await this.markRawEventState(rawEventId, 'deduped');
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
          if (
            rawEvent.connectorType === 'gmail' &&
            entity.type === 'person' &&
            !identifiers.some((id) => id.type === 'email')
          ) {
            continue;
          }
          let merged = false;
          for (const bucket of buckets) {
            if (shouldMergeEntityResolutionBucket(entity.type, entity.role, bucket, identifiers)) {
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
          if (!resolvedContacts.some((c) => c.contactId === contact.id && c.role === role)) {
            resolvedContacts.push({ contactId: contact.id, role, name: nameIdent?.value });
          }

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

    // 3. Media/file processing — extract searchable text where possible
    const primaryMedia = this.resolvePrimaryMedia(mergedMetadata, event.sourceType);
    const hasFile = !!(primaryMedia?.hasInlineContent || primaryMedia?.hasFetchableUrl);
    const fileMime = primaryMedia?.mimeType || '';
    let currentText = embedText;

    if (primaryMedia) {
      mergedMetadata.mediaExtraction = {
        status: hasFile ? 'pending' : 'unavailable',
        kind: primaryMedia.kind,
        mimeType: primaryMedia.mimeType || undefined,
        fileName: primaryMedia.fileName || undefined,
      };
    }

    if (hasFile && primaryMedia?.kind === 'image') {
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);
        if (fileBuffer.length <= 30_000) {
          mergedMetadata.thumbnailBase64 = fileBuffer.toString('base64');
        }
        if (fileBuffer.length <= MAX_IMAGE_DESCRIPTION_BYTES) {
          const description = await this.describeImageForSearch(
            fileBuffer,
            fileMime,
            primaryMedia.fileName,
          );
          if (description) {
            const extractedText = truncateMediaText(description);
            currentText = `${extractedText}\n\n${currentText}`;
            mergedMetadata.mediaExtraction = {
              ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
              status: 'extracted',
              extractedText,
            };
          }
        } else {
          mergedMetadata.mediaExtraction = {
            ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
            status: 'skipped_too_large',
            sizeBytes: fileBuffer.length,
          };
        }
      } catch (err: unknown) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:image] ${mid} image extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
        mergedMetadata.mediaExtraction = {
          ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (hasFile && primaryMedia?.kind !== 'image' && primaryMedia?.kind !== 'audio') {
      // Non-image files: parse via ContentCleaner
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);
        const fileContent = await this.contentCleaner.parseFile(
          fileBuffer,
          fileMime,
          primaryMedia.fileName,
        );
        if (fileContent) {
          const extractedText = truncateMediaText(fileContent);
          currentText = `${extractedText}\n\n${currentText}`;
          mergedMetadata.mediaExtraction = {
            ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
            status: 'extracted',
            extractedText,
          };
        } else {
          mergedMetadata.mediaExtraction = {
            ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
            status: 'unsupported',
          };
        }
      } catch (err: unknown) {
        this.addLog(
          rawEvent.connectorType,
          rawEvent.accountId,
          'warn',
          `[memory:file] ${mid} file processing failed: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
        mergedMetadata.mediaExtraction = {
          ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (hasFile && primaryMedia?.kind === 'audio') {
      mergedMetadata.mediaExtraction = {
        ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
        status: this.config.embedBackend === 'gemini' ? 'embedded_no_transcript' : 'unsupported',
        note:
          this.config.embedBackend === 'gemini'
            ? 'Audio is included in multimodal embedding, but no transcript is stored yet.'
            : 'Audio transcription backend is not configured.',
      };
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
      (primaryMedia?.kind === 'image' ||
        primaryMedia?.kind === 'audio' ||
        fileMime === 'application/pdf');

    if (canMultimodal) {
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);

        // For PDFs on Gemini path, still extract text for display if it was not already parsed.
        const mediaExtraction = mergedMetadata.mediaExtraction as
          | Record<string, unknown>
          | undefined;
        if (fileMime === 'application/pdf' && !mediaExtraction?.extractedText) {
          const pdfText = await this.contentCleaner.parseFile(fileBuffer, fileMime);
          if (pdfText) {
            currentText = pdfText + '\n\n' + currentText;
          }
        }

        const multimodalType: import('./gemini-embed.service').EmbedPart['type'] =
          primaryMedia?.kind === 'audio'
            ? 'audio'
            : fileMime.startsWith('image/')
              ? 'image'
              : 'pdf';
        const parts: import('./gemini-embed.service').EmbedPart[] = [
          {
            type: multimodalType,
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

    // Upsert to Postgres search
    t0 = Date.now();
    const peopleNames = resolvedContacts.map((c) => c.name).filter(Boolean) as string[];
    const roleIds = (roles: string[]) =>
      resolvedContacts.filter((c) => roles.includes(c.role)).map((c) => c.contactId);
    const metadataPeople = arrayFromUnknown(mergedMetadata.people).flatMap((p) =>
      typeof p === 'string'
        ? [p]
        : [p && typeof p === 'object' ? (p as { name?: unknown }).name : ''],
    );
    const locationValues = compactStrings([
      mergedMetadata.location,
      mergedMetadata.city,
      mergedMetadata.state,
      mergedMetadata.country,
      mergedMetadata.address,
      ...arrayFromUnknown(mergedMetadata.locations),
    ]);
    const organizations = compactStrings(
      embedResult.entities
        .filter((e) => e.type === 'organization')
        .map((e) => e.id.replace(/^name:/, '')),
    );
    const threadIds = compactStrings([
      mergedMetadata.threadId,
      mergedMetadata.chatId,
      ...embedResult.entities
        .filter((e) => e.type === 'message' && e.id.startsWith('thread:'))
        .map((e) => e.id.replace('thread:', '')),
    ]);
    const transactionTokens = compactStrings([
      mergedMetadata.amount,
      mergedMetadata.currency,
      mergedMetadata.counterparty,
      ...(currentText.match(
        /[a-z0-9]+(?:[._-][a-z0-9]+)*|\b(?:aed|usd|eur|gbp|sar|egp)\b|\d+(?:[.,]\d+)?/gi,
      ) ?? []),
    ]).map((token) => token.toLowerCase());
    const searchIndexPayload: Record<string, unknown> = {
      schema_version: MEMORY_INDEX_SCHEMA_VERSION,
      text: truncatedText,
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
      event_time: event.timestamp,
      account_id: rawEvent.accountId,
      user_id: ownerUserId,
      memory_bank_id: memoryBankId,
      people: peopleNames,
      person_ids: resolvedContacts.map((c) => c.contactId),
      person_aliases: compactStrings([...peopleNames, ...metadataPeople]),
      person_sender_ids: roleIds(['sender']),
      person_recipient_ids: roleIds(['recipient']),
      person_participant_ids: roleIds(['participant']),
      person_mentioned_ids: roleIds(['mentioned']),
      person_photo_ids:
        event.sourceType === 'photo' ? resolvedContacts.map((c) => c.contactId) : [],
      person_counterparty_ids: roleIds(['counterparty']),
      locations: locationValues,
      location_text: locationValues.join(' '),
      organizations,
      thread_ids: threadIds,
      transaction_tokens: transactionTokens,
    };
    await this.searchIndex.upsert(memoryId, vector, searchIndexPayload);
    const searchIndexMs = Date.now() - t0;

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
    const weights = { semantic: 0, recency, importance, trust, final: 0 };

    // 9. Encrypt all fields (single pass)
    currentText = stripNullBytes(currentText);
    this.stripInlineMediaContent(mergedMetadata);
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
        await this.markRawEventState(rawEventId, 'failed');
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
    const alreadyLinked = new Set(resolvedContacts.map((c) => c.contactId));
    for (const entity of enrichEntities) {
      if (entity.type !== 'person' || !entity.value) continue;
      if (rawEvent.connectorType === 'gmail') continue;
      try {
        const person = await this.contactsService.resolvePerson(
          [{ type: 'name', value: entity.value, connectorType: rawEvent.connectorType }],
          'person',
          ownerUserId || undefined,
        );
        if (alreadyLinked.has(person.id)) continue;
        await this.contactsService.linkMemory(memoryId, person.id, 'mentioned');
        alreadyLinked.add(person.id);
        contactCount++;
      } catch (err) {
        this.logger.debug(
          `[memory] weak mentioned link skipped for ${entity.value}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
      `[memory:done] ${memoryId.slice(0, 8)} in ${Date.now() - pipelineStart}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) embed=${embedMs}ms(${vector.length}d) search index=${searchIndexMs}ms entities=${enrichEntities.length} fact=${enrichFactuality?.label || 'UNVERIFIED'}`,
      parentJobId,
    );

    this.analytics.capture('memory_complete', {
      memory_id: memoryId,
      source_type: event.sourceType,
      connector_type: rawEvent.connectorType,
    });

    await this.markRawEventState(rawEventId, 'memory_created');

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

  private resolvePrimaryMedia(
    metadata: Record<string, unknown>,
    sourceType: unknown,
  ): PrimaryMedia | null {
    const attachments = arrayFromUnknown(metadata.attachments);
    const firstAttachment = attachments.find((item) => item && typeof item === 'object') as
      | Record<string, unknown>
      | undefined;
    const mimeType = normalizeMimeType(
      metadata.mimetype ||
        metadata.fileMimeType ||
        metadata.mimeType ||
        firstAttachment?.mimeType ||
        firstAttachment?.mimetype,
    );
    const fileName = String(
      metadata.fileName ||
        metadata.filename ||
        firstAttachment?.fileName ||
        firstAttachment?.filename ||
        '',
    ).trim();
    const kind = mediaKindFromMime(mimeType, metadata.messageType, sourceType);
    const hasInlineContent = typeof metadata.fileBase64 === 'string' && metadata.fileBase64 !== '';
    const hasFetchableUrl = typeof metadata.fileUrl === 'string' && metadata.fileUrl !== '';
    if (!mimeType && !fileName && kind === 'unknown' && !hasInlineContent && !hasFetchableUrl) {
      return null;
    }
    return {
      kind,
      mimeType,
      fileName: fileName || undefined,
      hasInlineContent,
      hasFetchableUrl,
    };
  }

  private async describeImageForSearch(
    fileBuffer: Buffer,
    mimeType: string,
    fileName?: string,
  ): Promise<string> {
    const prompt = [
      'Extract searchable information from this image for a private memory system.',
      'Include any visible text exactly enough to search it, then summarize the scene, people, places, document type, dates, names, organizations, and identifiers.',
      'If this is a document/photo of a document, prioritize OCR-like text and official fields over visual style.',
      'Do not invent missing details. Keep it concise.',
      fileName ? `Filename: ${fileName}` : '',
      mimeType ? `MIME type: ${mimeType}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return this.ai.generate(prompt, [fileBuffer.toString('base64')], 1);
  }

  private stripInlineMediaContent(metadata: Record<string, unknown>) {
    if (typeof metadata.fileBase64 === 'string') {
      delete metadata.fileBase64;
      metadata.fileContentStored = false;
    }
    if (typeof metadata.thumbnailBase64 === 'string') {
      delete metadata.thumbnailBase64;
      metadata.thumbnailStored = false;
    }
  }

  private async getFileBuffer(
    metadata: Record<string, unknown>,
    rawEvent: { accountId: string; connectorType: string },
  ): Promise<Buffer> {
    const fileBase64 = (metadata.fileBase64 as string) || '';
    if (fileBase64) return Buffer.from(fileBase64, 'base64');

    const fileUrl = (metadata.fileUrl as string) || '';
    const mimetype = normalizeMimeType(
      metadata.mimetype || metadata.fileMimeType || metadata.mimeType,
    );
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

  private async processWhatsAppGroupIdentityEvent(
    rawEvent: LoadedRawEvent,
    event: ConnectorDataEvent,
    rawEventId: string,
    parentJobId: string | null,
    mid: string,
  ) {
    const identity = buildWhatsAppGroupIdentity(event, rawEvent.connectorType);
    if (!identity) {
      await this.markRawEventState(rawEventId, 'skipped_contact');
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const ownerUserId = await this.getAccountOwnerUserId(rawEvent.accountId);
    const group = await this.contactsService.resolvePerson(
      identity.groupIdentifiers,
      'group',
      ownerUserId || undefined,
    );

    let membersLinked = 0;
    for (const member of identity.members) {
      const person = await this.contactsService
        .resolvePerson(member.identifiers, undefined, ownerUserId || undefined)
        .catch((err) => {
          this.logger.warn(
            `[identity] WhatsApp member resolution failed for ${identity.groupJid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });
      if (!person) continue;

      await this.contactsService.upsertRelationship({
        sourcePersonId: person.id,
        targetPersonId: group.id,
        relationshipType: 'member_of',
        connectorType: rawEvent.connectorType,
        sourceId: rawEvent.sourceId,
        userId: ownerUserId,
        confidence: member.confidence,
        metadata: {
          groupJid: identity.groupJid,
          rawJid: member.rawJid,
        },
      });
      membersLinked++;
    }

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[identity:done] ${mid} whatsapp group=${identity.groupName} members=${membersLinked}/${identity.members.length}`,
      parentJobId,
    );
    await this.markRawEventState(rawEventId, 'identity_processed');
    await this.advanceAndComplete(parentJobId);
  }

  private async processGmailContactIdentityEvent(
    rawEvent: LoadedRawEvent,
    event: ConnectorDataEvent,
    embedResult: EmbedResult,
    metadata: Record<string, unknown>,
    rawEventId: string,
    parentJobId: string | null,
    mid: string,
  ) {
    const ownerUserId = await this.getAccountOwnerUserId(rawEvent.accountId);
    const buckets: Array<{ entityType: string; role: string; identifiers: IdentifierInput[] }> = [];

    for (const entity of embedResult.entities) {
      if (entity.type !== 'person' && entity.type !== 'organization') continue;
      const identifiers = this.parseEntityIdentifiers(entity, rawEvent.connectorType);
      if (!identifiers.length) continue;

      let merged = false;
      for (const bucket of buckets) {
        if (shouldMergeEntityResolutionBucket(entity.type, entity.role, bucket, identifiers)) {
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

    let peopleResolved = 0;
    const gmailPhotoUrl = metadata.photoUrl as string | undefined;
    for (const { entityType, identifiers } of buckets) {
      const resolveType = entityType === 'person' ? undefined : 'organization';
      const contact = await Promise.race([
        this.contactsService.resolvePerson(
          identifiers,
          resolveType as 'organization' | undefined,
          ownerUserId || undefined,
        ),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Contact resolution timed out after 30s')), 30_000),
        ),
      ]).catch((err) => {
        this.logger.warn(
          `[contact] Gmail contact resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });

      if (!contact) continue;
      peopleResolved++;
      if (entityType === 'person' && gmailPhotoUrl) {
        try {
          await this.contactsService.updateAvatar(contact.id, {
            url: gmailPhotoUrl,
            source: 'gmail',
          });
        } catch (err) {
          this.logger.warn(
            `[contact] Gmail avatar update failed for ${contact.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[contact:done] ${mid} source=${event.sourceId.slice(0, 40)} people=${peopleResolved}`,
      parentJobId,
    );
    await this.markRawEventState(rawEventId, 'contact_processed');
    await this.advanceAndComplete(parentJobId);
  }

  private async getAccountOwnerUserId(accountId: string): Promise<string | null> {
    try {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, accountId));
      return acct?.userId || null;
    } catch (err) {
      this.logger.warn(
        `[contact] Account owner lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
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

    const results = await this.searchIndex.recommend(memoryId, SIMILAR_MEMORY_LIMIT);
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

  private async markRawEventState(rawEventId: string, state: RawEventProcessingState) {
    await this.dbService.db
      .update(rawEvents)
      .set({ processingState: state })
      .where(eq(rawEvents.id, rawEventId));
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
