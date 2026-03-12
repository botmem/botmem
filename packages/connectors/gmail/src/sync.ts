import { google, type gmail_v1 } from 'googleapis';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
import { isNoise, isAutomatedSender } from '@botmem/connector-sdk';
import { createOAuth2Client } from './oauth.js';

const BATCH_SIZE = 500; // Gmail API max for messages.list
const CONCURRENCY = 20; // Parallel message fetches

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

  ctx.logger.info(`Starting Gmail sync, cursor: ${ctx.cursor || 'none'}`);

  // Get total message count for progress tracking
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const totalMessages = profile.data.messagesTotal || 0;
  ctx.logger.info(`Total messages in mailbox: ${totalMessages}`);

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: BATCH_SIZE,
    pageToken: ctx.cursor || undefined,
  });

  const messages = res.data.messages || [];
  const total = totalMessages;

  let filteredCount = 0;

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

  ctx.logger.info(`Fetched ${messages.length} message IDs, estimated total: ${total}`);
  emitProgress({ processed: 0, total });

  // Process messages in parallel batches
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    if (ctx.signal.aborted) break;

    const batch = messages.slice(i, i + CONCURRENCY);

    const details = await Promise.all(
      batch.map((msg) =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'full',
        }),
      ),
    );

    for (const detail of details) {
      if (ctx.signal?.aborted) break;

      const headers = detail.data.payload?.headers || [];
      const subject = headers.find((h) => h.name === 'Subject')?.value || '';
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const to = headers.find((h) => h.name === 'To')?.value || '';
      const cc = headers.find((h) => h.name === 'Cc')?.value || '';
      const date = headers.find((h) => h.name === 'Date')?.value || '';
      const messageId = headers.find((h) => h.name === 'Message-ID')?.value || '';
      const inReplyTo = headers.find((h) => h.name === 'In-Reply-To')?.value || '';
      const listUnsubscribe = headers.find((h) => h.name === 'List-Unsubscribe')?.value || '';

      const labels = detail.data.labelIds || [];

      // Filter by Gmail label: skip CATEGORY_PROMOTIONS and CATEGORY_SOCIAL
      // unless the message also has a KEEP label (e.g. STARRED, IMPORTANT)
      const hasNoiseLabel = labels.some((l) => NOISE_LABELS.has(l));
      const hasKeepLabel = labels.some((l) => KEEP_LABELS.has(l));
      if (hasNoiseLabel && !hasKeepLabel) {
        filteredCount++;
        continue;
      }

      // Filter by List-Unsubscribe header (marketing/newsletter)
      // but keep if it has a keep label (user explicitly cares about it)
      if (listUnsubscribe && !hasKeepLabel) {
        filteredCount++;
        continue;
      }

      // Filter by automated sender patterns
      if (isAutomatedSender({ from })) {
        filteredCount++;
        continue;
      }

      const body = extractBody(detail.data.payload);
      const attachments = extractAttachments(detail.data.payload);

      const fullText = `${subject}\n\n${body}`;

      // Apply shared noise filter on subject + body
      if (isNoise(fullText, { from, labels })) {
        filteredCount++;
        continue;
      }

      // Prefer Gmail internalDate (epoch ms, always reliable) over parsed Date header
      let timestamp: string;
      if (detail.data.internalDate) {
        timestamp = new Date(Number(detail.data.internalDate)).toISOString();
      } else if (date) {
        const parsed = new Date(date);
        timestamp = isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
      } else {
        timestamp = new Date().toISOString();
      }

      emit({
        sourceType: 'email',
        sourceId: detail.data.id!,
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
            inReplyTo: inReplyTo || undefined,
            labels,
            threadId: detail.data.threadId,
            snippet: detail.data.snippet,
            sizeEstimate: detail.data.sizeEstimate,
          },
        },
      });

      processed++;
    }

    emitProgress({ processed, total });
  }

  ctx.logger.info(`Synced ${processed} emails (${filteredCount} noise filtered)`);

  return {
    cursor: res.data.nextPageToken || null,
    hasMore: !!res.data.nextPageToken,
    processed,
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
