import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { eq, and, sql, inArray, desc } from 'drizzle-orm';
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
import { validateUrlForFetch } from '../utils/ssrf-guard';
import {
  rawEvents,
  memories,
  memoryLinks,
  memorySearchIndex,
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
import { buildWhatsAppContactIdentity } from './connector-normalizers/whatsapp-contact-identity';
import { RawEventPipelineClassifier } from './raw-event-pipeline-classifier.service';
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
  | 'quota_blocked'
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
  connectorUri?: string;
}

const CONNECTOR_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  gmail: 'Gmail',
  outlook: 'Outlook',
  imessage: 'iMessage',
  photos: 'Photos',
};

const MAX_MEDIA_TEXT_CHARS = 8_000;
const MAX_IMAGE_DESCRIPTION_BYTES = 12 * 1024 * 1024;
const MAX_LINKED_DOCUMENT_BYTES = 10 * 1024 * 1024;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const DOCUMENT_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
]);

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

function extractUrls(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(URL_RE)]
        .map((match) => match[0].replace(/[.,;:!?]+$/g, ''))
        .filter(Boolean),
    ),
  ];
}

function cleanGeneratedSearchText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim();
}

function normalizeEmailThreadSubject(value: unknown): string {
  return String(value || '')
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function connectorLabel(connectorType: string): string {
  return CONNECTOR_LABELS[connectorType] || connectorType;
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
    private rawEventClassifier: RawEventPipelineClassifier,
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
    const pipelineKind = this.rawEventClassifier.classify(rawEvent, event);

    if (pipelineKind === 'whatsapp_group_identity') {
      await this.processWhatsAppGroupIdentityEvent(rawEvent, event, rawEventId, parentJobId, mid);
      return;
    }

    if (pipelineKind === 'whatsapp_contact_identity') {
      await this.processWhatsAppContactIdentityEvent(rawEvent, event, rawEventId, parentJobId, mid);
      return;
    }

    if (pipelineKind === 'skip_contact') {
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

    if (pipelineKind === 'gmail_contact_identity') {
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
          eq(memories.accountId, rawEvent.accountId),
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
      const selfKeys = ownerUserId
        ? [`selfContactId:${ownerUserId}`, `selfPersonId:${ownerUserId}`]
        : [];
      if (selfKeys.length) {
        const selfRow = await this.dbService.db
          .select({ value: settings.value })
          .from(settings)
          .where(inArray(settings.key, selfKeys))
          .limit(1);
        selfContactId = selfRow[0]?.value || null;
      }

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
          const resolvedName =
            nameIdent?.value ||
            (contact.displayName
              ? (this.crypto.decrypt(contact.displayName) ?? contact.displayName)
              : undefined);
          if (!resolvedContacts.some((c) => c.contactId === contact.id && c.role === role)) {
            resolvedContacts.push({ contactId: contact.id, role, name: resolvedName });
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
    const hasFile = !!(
      primaryMedia?.hasInlineContent ||
      primaryMedia?.hasFetchableUrl ||
      primaryMedia?.connectorUri
    );
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

    if (rawEvent.connectorType === 'whatsapp' && event.sourceType === 'message') {
      const meta = mergedMetadata as Record<string, unknown>;
      const isIncoming = meta.fromMe === false || meta.isFromMe === false;
      const senderName =
        typeof meta.senderName === 'string' && meta.senderName.trim()
          ? meta.senderName.trim()
          : undefined;
      const fallbackSender = compactStrings([
        resolvedContacts.find((c) => c.role === 'sender')?.name,
        meta.senderPhone,
        meta.pushName,
        meta.senderLid,
      ])[0];
      if (isIncoming && !senderName && fallbackSender) {
        meta.senderName = fallbackSender;
        currentText = currentText.replace(/^Unknown(?=:|\s+sent\b)/i, fallbackSender);
      }
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
            mergedMetadata.mediaExtraction = this.buildMediaExtractionMetadata({
              existing: mergedMetadata.mediaExtraction as Record<string, unknown>,
              status: 'extracted',
              source: 'vision_ocr',
              extractedText,
              eventTimestamp: event.timestamp,
            });
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
          mergedMetadata.mediaExtraction = this.buildMediaExtractionMetadata({
            existing: mergedMetadata.mediaExtraction as Record<string, unknown>,
            status: 'extracted',
            source: 'file_parser',
            extractedText,
            eventTimestamp: event.timestamp,
          });
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
      try {
        const fileBuffer = await this.getFileBuffer(mergedMetadata, rawEvent);
        const transcript = await this.ai.transcribeAudio(
          fileBuffer,
          fileMime || 'audio/ogg',
          primaryMedia.fileName,
        );
        const extractedText = truncateMediaText(transcript);
        if (extractedText) {
          currentText = `${extractedText}\n\n${currentText}`;
          mergedMetadata.mediaExtraction = this.buildMediaExtractionMetadata({
            existing: mergedMetadata.mediaExtraction as Record<string, unknown>,
            status: 'extracted',
            source: 'audio_transcription',
            extractedText,
            eventTimestamp: event.timestamp,
          });
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
          `[memory:audio] ${mid} audio transcription failed: ${err instanceof Error ? err.message : String(err)}`,
          parentJobId,
        );
        mergedMetadata.mediaExtraction = {
          ...(mergedMetadata.mediaExtraction as Record<string, unknown>),
          status: this.config.embedBackend === 'gemini' ? 'embedded_no_transcript' : 'unsupported',
          error: err instanceof Error ? err.message : String(err),
          note:
            this.config.embedBackend === 'gemini'
              ? 'Audio is included in multimodal embedding, but no transcript is stored.'
              : 'Audio transcription backend is not configured.',
        };
      }
    }

    if (!hasFile && /https?:\/\//i.test(currentText)) {
      const linkedDocuments = [];
      for (const url of extractUrls(currentText).slice(0, 3)) {
        try {
          const linked = await this.fetchLinkedDocument(url);
          if (!linked) continue;
          const fileContent = await this.contentCleaner.parseFile(
            linked.buffer,
            linked.mimeType,
            linked.fileName,
          );
          if (!fileContent) continue;
          const extractedText = truncateMediaText(fileContent);
          const searchSummary = await this.summarizeLinkedDocumentForSearch({
            sourceUrl: url,
            finalUrl: linked.url,
            fileName: linked.fileName,
            mimeType: linked.mimeType,
            extractedText,
          });
          const searchableText = [
            this.buildLinkedDocumentSearchContext(
              url,
              linked.url,
              linked.fileName,
              linked.mimeType,
            ),
            searchSummary ? `Document summary: ${searchSummary}` : '',
            extractedText,
          ]
            .filter(Boolean)
            .join('\n\n');
          currentText = `${searchableText}\n\n${currentText}`;
          linkedDocuments.push({
            url: linked.url,
            sourceUrl: url,
            mimeType: linked.mimeType,
            fileName: linked.fileName,
            sizeBytes: linked.buffer.length,
            status: 'extracted',
            source: 'linked_document_parser',
            confidence: 0.85,
            confidenceLabel: 'high',
            warnings: [],
            extractedText,
            searchSummary,
            searchableText,
          });
        } catch (err: unknown) {
          linkedDocuments.push({
            url,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          this.addLog(
            rawEvent.connectorType,
            rawEvent.accountId,
            'warn',
            `[memory:url] ${mid} linked document extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            parentJobId,
          );
        }
      }
      if (linkedDocuments.length) {
        mergedMetadata.linkedDocuments = linkedDocuments;
      }
    }

    const linkedDocumentCount = arrayFromUnknown(mergedMetadata.linkedDocuments).filter(
      (doc) =>
        doc && typeof doc === 'object' && (doc as Record<string, unknown>).status === 'extracted',
    ).length;
    const memorySourceType =
      !primaryMedia && linkedDocumentCount > 0
        ? 'file'
        : this.memorySourceTypeForEvent(event.sourceType, primaryMedia);
    if (primaryMedia) {
      currentText = this.buildMediaMemoryText({
        connectorType: rawEvent.connectorType,
        originalSourceType: event.sourceType,
        media: primaryMedia,
        metadata: mergedMetadata,
        originalText: embedText,
        currentText,
      });
      mergedMetadata.mediaMemory = {
        sourceConnector: rawEvent.connectorType,
        sourceLabel: connectorLabel(rawEvent.connectorType),
        originalSourceType: event.sourceType,
        memorySourceType,
        representedAs: memorySourceType,
      };
    } else if (linkedDocumentCount > 0) {
      currentText = this.buildLinkedDocumentMemoryText({
        connectorType: rawEvent.connectorType,
        originalSourceType: event.sourceType,
        documents: arrayFromUnknown(mergedMetadata.linkedDocuments) as Record<string, unknown>[],
        originalText: embedText,
        currentText,
      });
      mergedMetadata.mediaMemory = {
        sourceConnector: rawEvent.connectorType,
        sourceLabel: connectorLabel(rawEvent.connectorType),
        originalSourceType: event.sourceType,
        memorySourceType,
        representedAs: memorySourceType,
        linkedDocumentCount,
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

    // Build the Postgres search payload. The actual upsert happens after the
    // memory row exists because memory_search_index has a memory FK.
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
      mergedMetadata.emailThreadKey,
      mergedMetadata.chatId,
      ...arrayFromUnknown(mergedMetadata.referenceIds),
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
      source_type: memorySourceType,
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
    // 8. Enrich inline (best-effort)
    let enrichEntities: Array<{ type: string; value: string }> = [];
    let enrichFactuality: { label: string; confidence: number; rationale: string } | null = null;
    try {
      const enrichResult = await this.enrichService.enrichInline({
        text: currentText,
        sourceType: memorySourceType,
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
    enrichFactuality = this.guardMediaFactuality(enrichFactuality, mergedMetadata);

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
        await this.markRawEventState(rawEventId, 'quota_blocked');
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
            sourceType: memorySourceType,
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
          .onConflictDoNothing({
            target: [memories.accountId, memories.sourceId, memories.connectorType],
          }),
      );
      // 10. Compute search_tokens from plaintext
      await this.dbService.withUserId(ownerUserId, (db) =>
        db
          .update(memories)
          .set({ searchTokens: sql`to_tsvector('english', ${currentText})` })
          .where(
            and(
              eq(memories.sourceId, event.sourceId),
              eq(memories.connectorType, rawEvent.connectorType),
              eq(memories.accountId, rawEvent.accountId),
            ),
          ),
      );
    } else {
      await this.dbService.db
        .insert(memories)
        .values({
          id: memoryId,
          accountId: rawEvent.accountId,
          memoryBankId,
          connectorType: rawEvent.connectorType,
          sourceType: memorySourceType,
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
        .onConflictDoNothing({
          target: [memories.accountId, memories.sourceId, memories.connectorType],
        });
      await this.dbService.db
        .update(memories)
        .set({ searchTokens: sql`to_tsvector('english', ${currentText})` })
        .where(
          and(
            eq(memories.sourceId, event.sourceId),
            eq(memories.connectorType, rawEvent.connectorType),
            eq(memories.accountId, rawEvent.accountId),
          ),
        );
    }
    const dbInsertMs = Date.now() - t0;
    const persistedMemoryRows = await this.dbService.systemDb((db) =>
      db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.sourceId, event.sourceId),
            eq(memories.connectorType, rawEvent.connectorType),
            eq(memories.accountId, rawEvent.accountId),
          ),
        )
        .limit(1),
    );
    const persistedMemoryId = persistedMemoryRows[0]?.id;
    if (!persistedMemoryId) {
      throw new Error(
        `Memory insert did not produce a row for ${rawEvent.connectorType}:${event.sourceId}`,
      );
    }

    t0 = Date.now();
    await this.searchIndex.upsert(persistedMemoryId, vector, searchIndexPayload);
    const searchIndexMs = Date.now() - t0;

    // Bump quota cache
    if (ownerUserId) {
      this.quotaService.incrementCachedCount(ownerUserId);
    }

    // Link contacts + threads
    const memoryPersonLinks: Array<{ personId: string; role: string }> = [];
    if (selfContactId) {
      memoryPersonLinks.push({ personId: selfContactId, role: 'participant' });
    }
    for (const { contactId, role } of resolvedContacts) {
      memoryPersonLinks.push({ personId: contactId, role });
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
        memoryPersonLinks.push({ personId: person.id, role: 'mentioned' });
        alreadyLinked.add(person.id);
      } catch (err) {
        this.logger.debug(
          `[memory] weak mentioned link skipped for ${entity.value}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const contactCount = await this.contactsService.linkMemoryBatch(
      persistedMemoryId,
      memoryPersonLinks,
    );

    // Thread linking
    for (const entity of embedResult.entities) {
      if (entity.type === 'message' && entity.id.startsWith('thread:')) {
        try {
          await this.linkThread(
            persistedMemoryId,
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
          persistedMemoryId,
          mergedMetadata.threadId as string,
          rawEvent.connectorType,
          ownerUserId ?? undefined,
        );
      } catch (err) {
        this.logger.warn('Thread linking failed', err instanceof Error ? err.message : String(err));
      }
    }
    if (
      mergedMetadata.emailThreadKey &&
      mergedMetadata.emailThreadKey !== mergedMetadata.threadId
    ) {
      try {
        await this.linkThread(
          persistedMemoryId,
          mergedMetadata.emailThreadKey as string,
          rawEvent.connectorType,
          ownerUserId ?? undefined,
        );
      } catch (err) {
        this.logger.warn(
          'Email thread-key linking failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (rawEvent.connectorType === 'gmail' && threadIds.length > 0) {
      try {
        await this.upsertEmailThreadAggregate({
          rawEvent,
          ownerUserId,
          memoryBankId,
          threadId: String(
            mergedMetadata.emailThreadKey || mergedMetadata.threadId || threadIds[0],
          ),
          subject: normalizeEmailThreadSubject(mergedMetadata.subject),
          currentMemoryId: persistedMemoryId,
          currentText,
          currentEventTime: new Date(event.timestamp),
          currentPeopleNames: peopleNames,
          currentPersonIds: resolvedContacts.map((c) => c.contactId),
        });
      } catch (err) {
        this.logger.warn(
          `[thread] aggregate update failed for ${persistedMemoryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 12. Create links (best-effort). Recommendation queries are comparatively
    // expensive, so do not block memory creation or bulk rebuild throughput on
    // them. Search and retrieval only require the memory row + search index.
    void this.createLinks(persistedMemoryId).catch(() => {
      // Link creation is best-effort.
    });

    // Fire hooks
    void this.pluginRegistry.fireHook('afterIngest', {
      id: persistedMemoryId,
      text: embedText,
      sourceType: memorySourceType,
      connectorType: rawEvent.connectorType,
      eventTime: new Date(event.timestamp),
    });
    void this.pluginRegistry.fireHook('afterEmbed', {
      id: persistedMemoryId,
      text: embedText,
      sourceType: memorySourceType,
      connectorType: rawEvent.connectorType,
      eventTime: new Date(event.timestamp),
    });

    // Emit memory updated event
    this.events.emitToChannel('memories', 'memory:updated', {
      memoryId: persistedMemoryId,
      sourceType: memorySourceType,
      connectorType: rawEvent.connectorType,
      text: currentText.slice(0, 100),
    });
    this.emitGraphDelta(persistedMemoryId);

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[memory:done] ${persistedMemoryId.slice(0, 8)} in ${Date.now() - pipelineStart}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) embed=${embedMs}ms(${vector.length}d) search index=${searchIndexMs}ms entities=${enrichEntities.length} fact=${enrichFactuality?.label || 'UNVERIFIED'}`,
      parentJobId,
    );

    this.analytics.capture('memory_complete', {
      memory_id: persistedMemoryId,
      source_type: memorySourceType,
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
    const connectorUri = String(firstAttachment?.uri || metadata.fileUri || '').trim();
    if (
      !mimeType &&
      !fileName &&
      kind === 'unknown' &&
      !hasInlineContent &&
      !hasFetchableUrl &&
      !connectorUri
    ) {
      return null;
    }
    return {
      kind,
      mimeType,
      fileName: fileName || undefined,
      hasInlineContent,
      hasFetchableUrl,
      connectorUri: connectorUri || undefined,
    };
  }

  private memorySourceTypeForEvent(sourceType: string, media: PrimaryMedia | null): string {
    if (!media) return sourceType;
    if (sourceType === 'photo') return 'photo';
    if (sourceType === 'file') return 'file';
    return 'file';
  }

  private buildMediaMemoryText(input: {
    connectorType: string;
    originalSourceType: string;
    media: PrimaryMedia;
    metadata: Record<string, unknown>;
    originalText: string;
    currentText: string;
  }): string {
    const extraction = input.metadata.mediaExtraction as Record<string, unknown> | undefined;
    const extractedText =
      typeof extraction?.extractedText === 'string' ? extraction.extractedText.trim() : '';
    const originalText = input.originalText.trim();
    const withoutExtraction =
      extractedText && input.currentText.startsWith(extractedText)
        ? input.currentText.slice(extractedText.length).trim()
        : input.currentText.trim();
    const messageText = originalText || withoutExtraction;
    const warnings = Array.isArray(extraction?.warnings)
      ? extraction.warnings.map((w) => String(w)).filter(Boolean)
      : [];
    const confidenceLabel =
      typeof extraction?.confidenceLabel === 'string' ? extraction.confidenceLabel : undefined;
    const sourceName = connectorLabel(input.connectorType);
    const lines = [
      `File from ${sourceName}`,
      `Connector: ${input.connectorType}`,
      `Original source type: ${input.originalSourceType}`,
      `Media type: ${input.media.kind}`,
      input.media.mimeType ? `MIME type: ${input.media.mimeType}` : '',
      input.media.fileName ? `Filename: ${input.media.fileName}` : '',
      messageText ? `Message context:\n${messageText}` : '',
      extractedText
        ? [
            `Extracted media text (${confidenceLabel || 'unknown'} confidence):`,
            extractedText,
            warnings.length ? `Extraction warnings: ${warnings.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
    ].filter(Boolean);

    return lines.join('\n\n');
  }

  private buildLinkedDocumentMemoryText(input: {
    connectorType: string;
    originalSourceType: string;
    documents: Record<string, unknown>[];
    originalText: string;
    currentText: string;
  }): string {
    const sourceName = connectorLabel(input.connectorType);
    const extractedDocs = input.documents.filter((doc) => doc.status === 'extracted');
    const docSections = extractedDocs.map((doc, index) => {
      const fileName = typeof doc.fileName === 'string' ? doc.fileName : '';
      const mimeType = typeof doc.mimeType === 'string' ? doc.mimeType : '';
      const summary = typeof doc.searchSummary === 'string' ? doc.searchSummary.trim() : '';
      const extractedText =
        typeof doc.extractedText === 'string' ? truncateMediaText(doc.extractedText) : '';
      return [
        `Linked file ${index + 1}`,
        fileName ? `Filename: ${fileName}` : '',
        mimeType ? `MIME type: ${mimeType}` : '',
        summary ? `Document summary:\n${summary}` : '',
        extractedText ? `Extracted document text:\n${extractedText}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    const messageText = input.originalText.trim();
    const lines = [
      `File from ${sourceName}`,
      `Connector: ${input.connectorType}`,
      `Original source type: ${input.originalSourceType}`,
      messageText ? `Message context:\n${messageText}` : '',
      ...docSections,
    ].filter(Boolean);
    return lines.length ? lines.join('\n\n') : input.currentText;
  }

  private async describeImageForSearch(
    fileBuffer: Buffer,
    mimeType: string,
    fileName?: string,
  ): Promise<string> {
    const prompt = [
      'Extract searchable information from this image for a private memory system.',
      'First transcribe visible text. Then, only if visually clear, summarize the scene, people, places, document type, dates, names, organizations, and identifiers.',
      'If this is a document/photo of a document, prioritize OCR-like text and official fields over visual style.',
      'If text or visual details are unclear, say they are unclear instead of guessing.',
      'Do not infer facts that are not directly visible in the image. Keep it concise.',
      'Return plain text only. Do not return JSON, Markdown, or fenced code blocks.',
      fileName ? `Filename: ${fileName}` : '',
      mimeType ? `MIME type: ${mimeType}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return cleanGeneratedSearchText(
      await this.ai.generate(prompt, [fileBuffer.toString('base64')], 1),
    );
  }

  private buildMediaExtractionMetadata(input: {
    status: string;
    source: string;
    extractedText?: string;
    eventTimestamp?: string;
    existing?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const warnings: string[] = [];
    const extractedText = input.extractedText || '';
    const yearMatches = [...extractedText.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) =>
      Number(m[1]),
    );
    const eventYear = input.eventTimestamp
      ? new Date(input.eventTimestamp).getUTCFullYear()
      : undefined;
    if (eventYear && yearMatches.some((year) => Math.abs(year - eventYear) >= 2)) {
      warnings.push('ocr_date_disagrees_with_event_time');
    }
    if (extractedText.length > 0 && extractedText.length < 24) {
      warnings.push('very_short_extraction');
    }
    const confidence =
      input.status !== 'extracted'
        ? 0
        : warnings.length
          ? 0.45
          : input.source === 'vision_ocr'
            ? 0.7
            : 0.85;
    return {
      ...(input.existing || {}),
      ...(input.extra || {}),
      status: input.status,
      source: input.source,
      confidence,
      confidenceLabel: confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low',
      warnings,
      extractedText: extractedText || undefined,
    };
  }

  private guardMediaFactuality(
    factuality: { label: string; confidence: number; rationale: string } | null,
    metadata: Record<string, unknown>,
  ): { label: string; confidence: number; rationale: string } | null {
    const extraction = metadata.mediaExtraction as Record<string, unknown> | undefined;
    const confidence =
      typeof extraction?.confidence === 'number' ? extraction.confidence : undefined;
    const warnings = Array.isArray(extraction?.warnings) ? extraction.warnings : [];
    if (confidence === undefined || (confidence >= 0.6 && warnings.length === 0)) {
      return factuality;
    }

    return {
      label: 'UNVERIFIED',
      confidence: Math.min(factuality?.confidence ?? 0.5, Math.max(confidence, 0.35)),
      rationale: [
        factuality?.rationale || 'Media-derived memory',
        `Media extraction confidence is ${confidence.toFixed(2)}`,
        warnings.length ? `warnings: ${warnings.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    };
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
    rawEvent: { accountId: string; connectorType: string; sourceId: string },
  ): Promise<Buffer> {
    const fileBase64 = (metadata.fileBase64 as string) || '';
    if (fileBase64) return Buffer.from(fileBase64, 'base64');

    const connectorUri = this.resolveConnectorAttachmentUri(metadata);
    if (connectorUri) {
      return this.fetchConnectorAttachment(connectorUri, rawEvent);
    }

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

  private resolveConnectorAttachmentUri(metadata: Record<string, unknown>): string {
    const attachments = arrayFromUnknown(metadata.attachments);
    const firstAttachment = attachments.find((item) => item && typeof item === 'object') as
      | Record<string, unknown>
      | undefined;
    return String(firstAttachment?.uri || metadata.fileUri || '').trim();
  }

  private async fetchConnectorAttachment(
    connectorUri: string,
    rawEvent: { accountId: string; connectorType: string; sourceId: string },
  ): Promise<Buffer> {
    if (rawEvent.connectorType === 'gmail') {
      return this.fetchGmailAttachment(connectorUri, rawEvent);
    }
    throw new Error(`Connector attachment fetch is not implemented for ${rawEvent.connectorType}`);
  }

  private async fetchGmailAttachment(
    connectorUri: string,
    rawEvent: { accountId: string; connectorType: string; sourceId: string },
  ): Promise<Buffer> {
    const match = connectorUri.match(/^gmail:\/\/attachment\/(.+)$/);
    if (!match?.[1]) throw new Error(`Unsupported Gmail attachment URI: ${connectorUri}`);

    const headers = await this.buildAuthHeaders(rawEvent.accountId, rawEvent.connectorType);
    if (!headers.Authorization)
      throw new Error('Gmail attachment fetch requires OAuth credentials');

    const messageId = encodeURIComponent(rawEvent.sourceId);
    const attachmentId = encodeURIComponent(match[1]);
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      {
        headers,
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Gmail attachment download failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data?: string };
    if (!data.data) throw new Error('Gmail attachment response did not include data');
    return Buffer.from(data.data, 'base64url');
  }

  private async fetchLinkedDocument(
    inputUrl: string,
  ): Promise<{ url: string; buffer: Buffer; mimeType: string; fileName?: string } | null> {
    const candidateUrls = inputUrl.startsWith('http://')
      ? [inputUrl, inputUrl.replace(/^http:\/\//i, 'https://')]
      : [inputUrl];
    let lastError: unknown;

    for (const candidateUrl of candidateUrls) {
      try {
        return await this.fetchLinkedDocumentCandidate(candidateUrl);
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError instanceof Error) throw lastError;
    return null;
  }

  private async fetchLinkedDocumentCandidate(
    inputUrl: string,
  ): Promise<{ url: string; buffer: Buffer; mimeType: string; fileName?: string } | null> {
    let currentUrl = inputUrl;
    for (let redirect = 0; redirect < 5; redirect++) {
      const urlCheck = validateUrlForFetch(currentUrl);
      if (!urlCheck.valid) throw new Error(urlCheck.reason || 'Blocked URL');

      const res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirect without location: ${res.status}`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        throw new Error(`Linked document download failed: ${res.status} ${res.statusText}`);
      }

      const mimeType = normalizeMimeType(res.headers.get('content-type'));
      if (!this.isSupportedLinkedDocument(mimeType, currentUrl)) return null;

      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > MAX_LINKED_DOCUMENT_BYTES) {
        throw new Error(`Linked document too large: ${contentLength} bytes`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_LINKED_DOCUMENT_BYTES) {
        throw new Error(`Linked document too large: ${buffer.length} bytes`);
      }

      return {
        url: currentUrl,
        buffer,
        mimeType,
        fileName: this.fileNameFromUrl(currentUrl, mimeType),
      };
    }
    throw new Error('Too many redirects');
  }

  private isSupportedLinkedDocument(mimeType: string, url: string): boolean {
    if (DOCUMENT_CONTENT_TYPES.has(mimeType)) return true;
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(pdf|docx?|xlsx?|csv|txt)$/.test(pathname);
  }

  private fileNameFromUrl(url: string, mimeType: string): string | undefined {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    if (mimeType === 'application/pdf') return 'linked-document.pdf';
    if (mimeType === 'text/plain') return 'linked-document.txt';
    if (mimeType === 'text/csv') return 'linked-document.csv';
    return undefined;
  }

  private buildLinkedDocumentSearchContext(
    sourceUrl: string,
    finalUrl: string,
    fileName: string | undefined,
    mimeType: string,
  ): string {
    const keywords = new Set<string>();
    for (const url of [sourceUrl, finalUrl]) {
      for (const token of this.extractSearchableUrlTokens(url)) {
        keywords.add(token);
      }
    }
    const keywordText = Array.from(keywords).join(' ');
    const lines = [
      'Linked document extracted from message.',
      fileName ? `File name: ${fileName}` : '',
      `File type: ${mimeType}`,
      keywords.size ? `URL keywords: ${keywordText}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private async summarizeLinkedDocumentForSearch(input: {
    sourceUrl: string;
    finalUrl: string;
    fileName: string | undefined;
    mimeType: string;
    extractedText: string;
  }): Promise<string> {
    const prompt = [
      'Create a concise retrieval summary for a private memory search index.',
      'Use only the provided document text, filename, MIME type, and URL-derived context.',
      'Do not invent people, dates, identifiers, events, or document type.',
      'If the document language is not English, include an English paraphrase of the key searchable terms.',
      'Prefer compact noun phrases and facts over prose.',
      'Return plain text only, maximum 120 words.',
      '',
      `Filename: ${input.fileName || 'unknown'}`,
      `MIME type: ${input.mimeType}`,
      `Source URL tokens: ${this.extractSearchableUrlTokens(input.sourceUrl).join(' ')}`,
      `Final URL tokens: ${this.extractSearchableUrlTokens(input.finalUrl).join(' ')}`,
      '',
      'Extracted document text:',
      input.extractedText.slice(0, 4_000),
    ].join('\n');

    try {
      return truncateMediaText(
        cleanGeneratedSearchText(await this.ai.generate(prompt, undefined, 1)),
      ).slice(0, 1_000);
    } catch (err) {
      this.logger.warn(
        `Linked document summary failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  private extractSearchableUrlTokens(url: string): string[] {
    try {
      const parsed = new URL(url);
      const raw = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
      const spaced = raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9]+/g, ' ');
      const tokens = spaced
        .split(/\s+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3 && !/^[0-9a-f-]{12,}$/i.test(token));
      return Array.from(new Set(tokens));
    } catch {
      return [];
    }
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

  private async processWhatsAppContactIdentityEvent(
    rawEvent: LoadedRawEvent,
    event: ConnectorDataEvent,
    rawEventId: string,
    parentJobId: string | null,
    mid: string,
  ) {
    const identity = buildWhatsAppContactIdentity(event, rawEvent.connectorType);
    if (!identity) {
      await this.markRawEventState(rawEventId, 'skipped_contact');
      await this.advanceAndComplete(parentJobId);
      return;
    }

    const ownerUserId = await this.getAccountOwnerUserId(rawEvent.accountId);
    const contact = await this.contactsService
      .resolvePerson(identity.identifiers, undefined, ownerUserId || undefined)
      .catch((err) => {
        this.logger.warn(
          `[identity] WhatsApp contact resolution failed for ${event.sourceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });

    this.addLog(
      rawEvent.connectorType,
      rawEvent.accountId,
      'info',
      `[identity:done] ${mid} whatsapp contact=${event.sourceId} people=${contact ? 1 : 0}`,
      parentJobId,
    );
    await this.markRawEventState(rawEventId, contact ? 'identity_processed' : 'skipped_contact');
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
      .select({ id: memorySearchIndex.memoryId })
      .from(memorySearchIndex)
      .where(
        and(
          eq(memorySearchIndex.connectorType, connectorType),
          sql`${memorySearchIndex.threadIds} @> ${JSON.stringify([threadId])}::jsonb`,
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

  private buildEmailThreadAggregateText(input: {
    subject?: string;
    messages: Array<{ eventTime: Date; text: string }>;
  }): string {
    const sorted = [...input.messages].sort(
      (a, b) => a.eventTime.getTime() - b.eventTime.getTime(),
    );
    const latest = sorted.at(-1);
    const lines = [
      `Email thread${input.subject ? `: ${input.subject}` : ''}`,
      latest ? `Latest state:\n${latest.text.slice(0, 1_200)}` : '',
      `Messages: ${sorted.length}`,
      'Timeline:',
      ...sorted.slice(-12).map((message) => {
        const preview = message.text.replace(/\s+/g, ' ').slice(0, 220);
        return `- ${message.eventTime.toISOString()}: ${preview}`;
      }),
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  private async upsertEmailThreadAggregate(input: {
    rawEvent: LoadedRawEvent;
    ownerUserId: string | null;
    memoryBankId: string | null;
    threadId: string;
    subject?: string;
    currentMemoryId: string;
    currentText: string;
    currentEventTime: Date;
    currentPeopleNames: string[];
    currentPersonIds: string[];
  }) {
    if (!input.ownerUserId || !input.threadId) return;
    const aggregateSourceId = `email-thread:${input.threadId}`;
    const threadRows = await this.dbService.systemDb((db) =>
      db
        .select({
          id: memories.id,
          text: memorySearchIndex.text,
          eventTime: memories.eventTime,
          sourceType: memories.sourceType,
        })
        .from(memorySearchIndex)
        .innerJoin(memories, eq(memorySearchIndex.memoryId, memories.id))
        .where(
          and(
            eq(memorySearchIndex.connectorType, input.rawEvent.connectorType),
            eq(memorySearchIndex.accountId, input.rawEvent.accountId),
            sql`${memorySearchIndex.threadIds} @> ${JSON.stringify([input.threadId])}::jsonb`,
            sql`${memories.sourceType} <> 'email_thread'`,
          ),
        )
        .orderBy(desc(memories.eventTime))
        .limit(50),
    );
    const byId = new Map<string, { eventTime: Date; text: string }>();
    for (const row of threadRows) {
      byId.set(row.id, { eventTime: row.eventTime, text: row.text });
    }
    byId.set(input.currentMemoryId, {
      eventTime: input.currentEventTime,
      text: input.currentText,
    });
    const messages = [...byId.values()];
    if (messages.length < 2) return;

    const aggregateText = this.buildEmailThreadAggregateText({
      subject: input.subject,
      messages,
    });
    const aggregateId =
      (
        await this.dbService.systemDb((db) =>
          db
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                eq(memories.accountId, input.rawEvent.accountId),
                eq(memories.connectorType, input.rawEvent.connectorType),
                eq(memories.sourceId, aggregateSourceId),
              ),
            )
            .limit(1),
        )
      )[0]?.id || randomUUID();
    const latestEventTime = messages.reduce(
      (latest, message) => (message.eventTime > latest ? message.eventTime : latest),
      messages[0].eventTime,
    );
    const metadata = {
      threadAggregate: true,
      threadId: input.threadId,
      emailThreadKey: input.threadId,
      subject: input.subject || undefined,
      messageCount: messages.length,
      sourceMemoryIds: [input.currentMemoryId, ...threadRows.map((row) => row.id)].filter(
        (id, index, all) => all.indexOf(id) === index,
      ),
    };
    const userKey = await this.userKeyService.getDek(input.ownerUserId);
    if (!userKey) return;
    const encrypted = this.crypto.encryptMemoryFieldsWithKey(
      {
        text: stripNullBytes(aggregateText),
        entities: '[]',
        claims: '[]',
        metadata: stripNullBytes(JSON.stringify(metadata)),
      },
      userKey,
    );
    const now = new Date();
    const weights = { semantic: 0, recency: 0.9, importance: 0.65, trust: 0.8, final: 0 };
    await this.dbService.withUserId(input.ownerUserId, (db) =>
      db
        .insert(memories)
        .values({
          id: aggregateId,
          accountId: input.rawEvent.accountId,
          memoryBankId: input.memoryBankId,
          connectorType: input.rawEvent.connectorType,
          sourceType: 'email_thread',
          sourceId: aggregateSourceId,
          text: encrypted.text,
          eventTime: latestEventTime,
          ingestTime: now,
          metadata: encrypted.metadata,
          entities: encrypted.entities,
          claims: encrypted.claims,
          factuality: this.crypto.encrypt(
            JSON.stringify({
              label: 'UNVERIFIED',
              confidence: 0.75,
              rationale: 'Aggregate of related email messages in the same thread.',
            }),
          )!,
          factualityLabel: 'UNVERIFIED',
          weights,
          embeddingStatus: 'done',
          pipelineComplete: true,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [memories.accountId, memories.sourceId, memories.connectorType],
          set: {
            text: encrypted.text,
            eventTime: latestEventTime,
            metadata: encrypted.metadata,
            weights,
            embeddingStatus: 'done',
            pipelineComplete: true,
          },
        }),
    );
    await this.dbService.withUserId(input.ownerUserId, (db) =>
      db
        .update(memories)
        .set({ searchTokens: sql`to_tsvector('english', ${aggregateText})` })
        .where(eq(memories.id, aggregateId)),
    );
    const vector = await this.ai.embed(aggregateText.slice(0, 6000));
    await this.searchIndex.upsert(aggregateId, vector, {
      schema_version: MEMORY_INDEX_SCHEMA_VERSION,
      text: aggregateText.slice(0, 6000),
      source_type: 'email_thread',
      connector_type: input.rawEvent.connectorType,
      event_time: latestEventTime,
      account_id: input.rawEvent.accountId,
      user_id: input.ownerUserId,
      memory_bank_id: input.memoryBankId,
      people: input.currentPeopleNames,
      person_ids: input.currentPersonIds,
      person_aliases: input.currentPeopleNames,
      thread_ids: [input.threadId],
      transaction_tokens:
        aggregateText.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*|\d+(?:[.,]\d+)?/gi) ?? [],
    });
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
