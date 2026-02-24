import { google, type gmail_v1 } from 'googleapis';
import type { SyncContext, ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
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
  const redirectUri = (ctx.auth.raw?.redirectUri as string | undefined) || 'http://localhost:3001/api/auth/gmail/callback';
  const auth = clientId && clientSecret
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
      if (ctx.signal.aborted) break;

      const headers = detail.data.payload?.headers || [];
      const subject = headers.find((h) => h.name === 'Subject')?.value || '';
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const to = headers.find((h) => h.name === 'To')?.value || '';
      const cc = headers.find((h) => h.name === 'Cc')?.value || '';
      const date = headers.find((h) => h.name === 'Date')?.value || '';
      const messageId = headers.find((h) => h.name === 'Message-ID')?.value || '';
      const inReplyTo = headers.find((h) => h.name === 'In-Reply-To')?.value || '';

      const body = extractBody(detail.data.payload);
      const attachments = extractAttachments(detail.data.payload);

      emit({
        sourceType: 'email',
        sourceId: detail.data.id!,
        timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
        content: {
          text: `Subject: ${subject}\n\n${body}`,
          participants: [from, to, cc].filter(Boolean),
          attachments: attachments.length > 0 ? attachments : undefined,
          metadata: {
            subject,
            from,
            to,
            cc: cc || undefined,
            messageId: messageId || undefined,
            inReplyTo: inReplyTo || undefined,
            labels: detail.data.labelIds,
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

  ctx.logger.info(`Synced ${processed} emails`);

  return {
    cursor: res.data.nextPageToken || null,
    hasMore: !!res.data.nextPageToken,
    processed,
  };
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
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
  const attachments: Array<{ uri: string; mimeType: string; filename?: string; size?: number }> = [];
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
