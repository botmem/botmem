import { google, type gmail_v1 } from 'googleapis';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
import { isNoise, isAutomatedSender } from '@botmem/connector-sdk';
import { createOAuth2Client } from './oauth.js';

const BATCH_SIZE = 500; // Gmail API max for messages.list
const CONCURRENCY = 20; // Parallel message fetches

type GmailResponse<T> = { data: T };

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === lower)?.value || '';
}

function normalizeEmailSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeThreadToken(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function extractReferenceIds(value: string): string[] {
  const angleIds = value.match(/<[^>]+>/g);
  const rawIds = angleIds?.length ? angleIds : value.split(/\s+/);
  return [...new Set(rawIds.map(normalizeThreadToken).filter((id) => id.includes('@')))];
}

type GmailCursor =
  | {
      kind: 'gmail';
      version: 1;
      mode: 'backfill';
      pageToken: string;
      targetHistoryId: string | null;
    }
  | {
      kind: 'gmail';
      version: 1;
      mode: 'history';
      historyId: string;
      pageToken?: string;
      targetHistoryId?: string | null;
    };

function encodeCursor(cursor: GmailCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(cursor: string | null): GmailCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<GmailCursor>;
    if (parsed.kind !== 'gmail' || parsed.version !== 1) return null;
    if (parsed.mode === 'backfill' && typeof parsed.pageToken === 'string') {
      return {
        kind: 'gmail',
        version: 1,
        mode: 'backfill',
        pageToken: parsed.pageToken,
        targetHistoryId: typeof parsed.targetHistoryId === 'string' ? parsed.targetHistoryId : null,
      };
    }
    if (parsed.mode === 'history' && typeof parsed.historyId === 'string') {
      return {
        kind: 'gmail',
        version: 1,
        mode: 'history',
        historyId: parsed.historyId,
        pageToken: typeof parsed.pageToken === 'string' ? parsed.pageToken : undefined,
        targetHistoryId:
          typeof parsed.targetHistoryId === 'string' ? parsed.targetHistoryId : undefined,
      };
    }
  } catch {
    // Legacy cursors were Gmail page tokens. They are not durable across scheduled syncs.
  }
  return null;
}

export function isGmailContinuationCursor(cursor: string | null): boolean {
  const decoded = decodeCursor(cursor);
  return !!decoded?.pageToken;
}

export async function syncGmail(
  ctx: SyncContext,
  emit: (event: ConnectorDataEvent) => void,
  emitProgress: (event: ProgressEvent) => void,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  const clientId = ctx.auth.raw?.clientId as string | undefined;
  const clientSecret = ctx.auth.raw?.clientSecret as string | undefined;
  const redirectUri =
    (ctx.auth.raw?.redirectUri as string | undefined) ||
    'http://localhost:12412/api/auth/gmail/callback';
  const auth =
    clientId && clientSecret
      ? createOAuth2Client(clientId, clientSecret, redirectUri)
      : new google.auth.OAuth2();
  auth.setCredentials({
    access_token: ctx.auth.accessToken,
    refresh_token: ctx.auth.refreshToken,
  });

  const gmail = google.gmail({ version: 'v1', auth });
  let processed = 0;

  const cursor = decodeCursor(ctx.cursor);
  if (ctx.cursor && !cursor) {
    ctx.logger.warn('Ignoring legacy Gmail page cursor; starting a full backfill');
  }
  ctx.logger.info(`Starting Gmail sync, mode: ${cursor?.mode || 'backfill'}`);

  // Get total message count for progress tracking
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const totalMessages = profile.data.messagesTotal || 0;
  const profileHistoryId = profile.data.historyId || null;
  ctx.logger.info(`Total messages in mailbox: ${totalMessages}`);

  if (cursor?.mode === 'history') {
    return syncGmailHistory({
      gmail,
      cursor,
      emit,
      emitProgress,
      logger: ctx.logger,
      signal: ctx.signal,
      fallbackHistoryId: profileHistoryId,
    });
  }

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: BATCH_SIZE,
    pageToken: cursor?.mode === 'backfill' ? cursor.pageToken : undefined,
  });

  const messages = res.data.messages || [];
  const total = totalMessages;

  let filteredCount = 0;

  ctx.logger.info(`Fetched ${messages.length} message IDs, estimated total: ${total}`);
  emitProgress({ processed: 0, total });

  // Process messages in parallel batches
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    if (ctx.signal.aborted) break;

    const batch = messages.slice(i, i + CONCURRENCY);

    const details = await fetchMessageDetails(
      gmail,
      batch.map((msg) => msg.id).filter(Boolean) as string[],
      ctx.logger,
    );

    for (const detail of details) {
      if (ctx.signal?.aborted) break;

      const event = buildEmailEvent(detail.data);
      if (!event) {
        filteredCount++;
        continue;
      }
      emit(event);

      processed++;
    }

    emitProgress({ processed, total });
  }

  ctx.logger.info(`Synced ${processed} emails (${filteredCount} noise filtered)`);

  return {
    cursor: res.data.nextPageToken
      ? encodeCursor({
          kind: 'gmail',
          version: 1,
          mode: 'backfill',
          pageToken: res.data.nextPageToken,
          targetHistoryId: profileHistoryId,
        })
      : profileHistoryId
        ? encodeCursor({
            kind: 'gmail',
            version: 1,
            mode: 'history',
            historyId: profileHistoryId,
          })
        : null,
    hasMore: !!res.data.nextPageToken,
    processed,
  };
}

async function syncGmailHistory({
  gmail,
  cursor,
  emit,
  emitProgress,
  logger,
  signal,
  fallbackHistoryId,
}: {
  gmail: gmail_v1.Gmail;
  cursor: Extract<GmailCursor, { mode: 'history' }>;
  emit: (event: ConnectorDataEvent) => void;
  emitProgress: (event: ProgressEvent) => void;
  logger: SyncContext['logger'];
  signal: AbortSignal;
  fallbackHistoryId: string | null;
}): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  let historyRes: GmailResponse<gmail_v1.Schema$ListHistoryResponse>;
  try {
    historyRes = (await gmail.users.history.list({
      userId: 'me',
      startHistoryId: cursor.historyId,
      pageToken: cursor.pageToken,
      historyTypes: ['messageAdded'],
      maxResults: BATCH_SIZE,
    })) as GmailResponse<gmail_v1.Schema$ListHistoryResponse>;
  } catch (err) {
    if (isExpiredHistoryError(err)) {
      logger.warn('Gmail history cursor expired; starting a full backfill');
      return {
        cursor: null,
        hasMore: true,
        processed: 0,
      };
    }
    throw err;
  }

  const messageIds = new Set<string>();
  for (const record of historyRes.data.history || []) {
    for (const added of record.messagesAdded || []) {
      if (added.message?.id) messageIds.add(added.message.id);
    }
  }

  const ids = [...messageIds];
  logger.info(`Fetched ${ids.length} Gmail history message ID(s)`);
  emitProgress({ processed: 0, total: ids.length });

  let processed = 0;
  let filteredCount = 0;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    if (signal.aborted) break;
    const batch = ids.slice(i, i + CONCURRENCY);
    const details = await fetchMessageDetails(gmail, batch, logger);

    for (const detail of details) {
      if (signal.aborted) break;
      const event = buildEmailEvent(detail.data);
      if (!event) {
        filteredCount++;
        continue;
      }
      emit(event);
      processed++;
    }
    emitProgress({ processed, total: ids.length });
  }

  logger.info(
    `Synced ${processed} new emails from Gmail history (${filteredCount} noise filtered)`,
  );

  const targetHistoryId =
    historyRes.data.historyId || cursor.targetHistoryId || fallbackHistoryId || cursor.historyId;
  return {
    cursor: historyRes.data.nextPageToken
      ? encodeCursor({
          kind: 'gmail',
          version: 1,
          mode: 'history',
          historyId: cursor.historyId,
          pageToken: historyRes.data.nextPageToken,
          targetHistoryId,
        })
      : encodeCursor({
          kind: 'gmail',
          version: 1,
          mode: 'history',
          historyId: targetHistoryId,
        }),
    hasMore: !!historyRes.data.nextPageToken,
    processed,
  };
}

function isExpiredHistoryError(err: unknown): boolean {
  const maybe = err as { code?: number; response?: { status?: number }; message?: string };
  const code = maybe.code ?? maybe.response?.status;
  return code === 404 || (code === 400 && /history/i.test(maybe.message || ''));
}

async function fetchMessageDetails(
  gmail: gmail_v1.Gmail,
  ids: string[],
  logger: SyncContext['logger'],
): Promise<Array<GmailResponse<gmail_v1.Schema$Message>>> {
  const settled = await Promise.allSettled(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      }),
    ),
  );

  const details: Array<GmailResponse<gmail_v1.Schema$Message>> = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      details.push(result.value as GmailResponse<gmail_v1.Schema$Message>);
      return;
    }
    if (isMissingMessageError(result.reason)) {
      logger.warn(
        `Skipping unavailable Gmail message ${ids[index]}: ${errorMessage(result.reason)}`,
      );
      return;
    }
    throw result.reason;
  });
  return details;
}

function isMissingMessageError(err: unknown): boolean {
  const maybe = err as { code?: number; response?: { status?: number }; message?: string };
  const code = maybe.code ?? maybe.response?.status;
  return code === 404 || /requested entity was not found/i.test(maybe.message || '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Labels that indicate promotional/social noise — skip these */
const NOISE_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);

/** Labels that indicate personal/important mail — always keep */
const KEEP_LABELS = new Set([
  'INBOX',
  'SENT',
  'IMPORTANT',
  'STARRED',
  'CATEGORY_UPDATES',
  'CATEGORY_PERSONAL',
  'CATEGORY_FORUMS',
]);

function buildEmailEvent(message: gmail_v1.Schema$Message): ConnectorDataEvent | null {
  const headers = message.payload?.headers || [];
  const subject = headerValue(headers, 'Subject');
  const from = headerValue(headers, 'From');
  const to = headerValue(headers, 'To');
  const cc = headerValue(headers, 'Cc');
  const date = headerValue(headers, 'Date');
  const messageId = headerValue(headers, 'Message-ID');
  const inReplyTo = headerValue(headers, 'In-Reply-To');
  const references = headerValue(headers, 'References');
  const listUnsubscribe = headerValue(headers, 'List-Unsubscribe');

  const labels = message.labelIds || [];

  // Filter by Gmail label: skip CATEGORY_PROMOTIONS and CATEGORY_SOCIAL
  // unless the message also has a KEEP label (e.g. STARRED, IMPORTANT)
  const hasNoiseLabel = labels.some((l) => NOISE_LABELS.has(l));
  const hasKeepLabel = labels.some((l) => KEEP_LABELS.has(l));
  if (hasNoiseLabel && !hasKeepLabel) return null;

  // Filter by List-Unsubscribe header (marketing/newsletter)
  // but keep if it has a keep label (user explicitly cares about it)
  if (listUnsubscribe && !hasKeepLabel) return null;

  // Filter by automated sender patterns
  if (isAutomatedSender({ from })) return null;

  const body = extractBody(message.payload);
  const attachments = extractAttachments(message.payload);

  const fullText = `${subject}\n\n${body}`;

  // Apply shared noise filter on subject + body
  if (isNoise(fullText, { from, labels })) return null;

  // Prefer Gmail internalDate (epoch ms, always reliable) over parsed Date header
  let timestamp: string;
  if (message.internalDate) {
    timestamp = new Date(Number(message.internalDate)).toISOString();
  } else if (date) {
    const parsed = new Date(date);
    timestamp = isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  const normalizedSubject = normalizeEmailSubject(subject);
  const normalizedMessageId = normalizeThreadToken(messageId);
  const normalizedInReplyTo = normalizeThreadToken(inReplyTo);
  const referenceIds = extractReferenceIds(references);
  const threadKey = message.threadId
    ? `gmail:${message.threadId}`
    : [
        normalizedInReplyTo || referenceIds[0] || normalizedMessageId,
        normalizedSubject || undefined,
      ]
        .filter(Boolean)
        .join(':');

  return {
    sourceType: 'email',
    sourceId: message.id!,
    timestamp,
    content: {
      text: fullText,
      participants: [from, to, cc].filter(Boolean),
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        subject,
        from,
        to,
        cc: cc || undefined,
        messageId: messageId || undefined,
        normalizedMessageId: normalizedMessageId || undefined,
        inReplyTo: inReplyTo || undefined,
        normalizedInReplyTo: normalizedInReplyTo || undefined,
        references: references || undefined,
        referenceIds: referenceIds.length ? referenceIds : undefined,
        normalizedSubject: normalizedSubject || undefined,
        emailThreadKey: threadKey || undefined,
        labels,
        threadId: message.threadId,
        snippet: message.snippet,
        sizeEstimate: message.sizeEstimate,
      },
    },
  };
}

/** Strip HTML tags and decode common entities to plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  // Single-part message: detect if it's HTML by mimeType or content
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    if (payload.mimeType === 'text/html') return stripHtml(decoded);
    return decoded;
  }

  if (payload.parts) {
    // Prefer text/plain, fall back to text/html (stripped)
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return stripHtml(html);
    }

    // Handle multipart/alternative or multipart/mixed nested parts
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
): Array<{ uri: string; mimeType: string; filename?: string; size?: number }> {
  const attachments: Array<{ uri: string; mimeType: string; filename?: string; size?: number }> =
    [];
  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        uri: `gmail://attachment/${part.body.attachmentId}`,
        mimeType: part.mimeType || 'application/octet-stream',
        filename: part.filename,
        size: part.body.size || undefined,
      });
    }
    // Recurse into nested parts
    if (part.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}
