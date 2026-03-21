/**
 * Outlook email sync via Microsoft Graph API.
 *
 * NOTE (SDK audit): The cursor semantics documentation is vague — "a string that
 * your connector controls" with no guidance on strategies. For Outlook, we use
 * receivedDateTime ISO string as the cursor for incremental sync with $filter.
 */

import type { ConnectorDataEvent, ProgressEvent } from '@botmem/connector-sdk';
import type { GraphClient } from './graph-client.js';

interface GraphEmailAddress {
  emailAddress: {
    name?: string;
    address?: string;
  };
}

interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  body?: { contentType: string; content: string };
  receivedDateTime?: string;
  conversationId?: string;
  hasAttachments?: boolean;
  categories?: string[];
  importance?: string;
  internetMessageId?: string;
  isRead?: boolean;
}

interface GraphMessagesResponse {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
}

interface GraphAttachmentsResponse {
  value: GraphAttachment[];
}

const MESSAGE_SELECT = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'body',
  'receivedDateTime',
  'conversationId',
  'hasAttachments',
  'categories',
  'importance',
  'internetMessageId',
  'isRead',
].join(',');

/**
 * Format a Graph API email address into "Name <email>" format for participants.
 */
function formatRecipient(recipient: GraphEmailAddress): string | null {
  const addr = recipient.emailAddress?.address;
  if (!addr) return null;
  const name = recipient.emailAddress?.name;
  return name ? `${name} <${addr}>` : addr;
}

/**
 * Strip HTML tags from email body content.
 * Simple approach — the SDK's BaseConnector.clean() may also do this,
 * but the docs don't explain what the default clean() does.
 *
 * NOTE (SDK audit): The BaseConnector has clean(), embed(), enrich() methods
 * that can be overridden, but these are NEVER mentioned in the "Building a
 * Connector" guide or the SDK reference. External devs won't know they exist
 * or what the defaults do.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function syncOutlookEmails(
  client: GraphClient,
  cursor: string | null,
  emitData: (event: ConnectorDataEvent) => boolean,
  emitProgress: (event: ProgressEvent) => boolean,
  signal?: AbortSignal,
): Promise<{ cursor: string | null; hasMore: boolean; processed: number }> {
  let processed = 0;
  let latestTimestamp: string | null = null;

  // Build initial URL with optional cursor filter for incremental sync
  // NOTE: OData DateTimeOffset comparisons must NOT be quoted
  let url: string | null =
    `/me/messages?$top=500&$orderby=receivedDateTime desc&$select=${MESSAGE_SELECT}`;
  if (cursor) {
    url += `&$filter=receivedDateTime gt ${cursor}`;
  }

  while (url) {
    if (signal?.aborted) break;

    const response: GraphMessagesResponse = await client.get<GraphMessagesResponse>(url);

    for (const message of response.value) {
      if (signal?.aborted) break;

      // Track the most recent timestamp for cursor
      if (message.receivedDateTime) {
        if (!latestTimestamp || message.receivedDateTime > latestTimestamp) {
          latestTimestamp = message.receivedDateTime;
        }
      }

      const event = await messageToEvent(message, client);
      if (event) {
        const emitted = emitData(event);
        if (emitted) {
          processed++;
        }
        // Note: emitData returns false both for noise-filtered events AND debug limit.
        // We don't break on false — just skip filtered events and continue.
        // The connector's isLimitReached check in the SyncProcessor handles debug limits.
      }
    }

    emitProgress({ processed });
    url = response['@odata.nextLink'] || null;
  }

  return {
    cursor: latestTimestamp || cursor,
    hasMore: false,
    processed,
  };
}

async function messageToEvent(
  message: GraphMessage,
  client: GraphClient,
): Promise<ConnectorDataEvent | null> {
  // Build participants from from/to/cc
  const participants: string[] = [];
  if (message.from) {
    const formatted = formatRecipient(message.from);
    if (formatted) participants.push(formatted);
  }
  for (const r of message.toRecipients || []) {
    const formatted = formatRecipient(r);
    if (formatted) participants.push(formatted);
  }
  for (const r of message.ccRecipients || []) {
    const formatted = formatRecipient(r);
    if (formatted) participants.push(formatted);
  }

  // Extract body text
  let text = '';
  if (message.body) {
    text =
      message.body.contentType === 'html' ? stripHtml(message.body.content) : message.body.content;
  }

  // Build "Subject: ... \n\n Body" format for better search
  if (message.subject) {
    text = `${message.subject}\n\n${text}`;
  }

  // Skip empty messages
  if (!text.trim() && participants.length === 0) return null;

  // Fetch attachments if present
  const attachments: Array<{ uri: string; mimeType: string }> = [];
  if (message.hasAttachments) {
    try {
      const attResponse = await client.get<GraphAttachmentsResponse>(
        `/me/messages/${message.id}/attachments?$select=id,name,contentType,size,isInline`,
      );
      for (const att of attResponse.value) {
        if (att.isInline) continue; // Skip inline images
        attachments.push({
          uri: `outlook://attachment/${message.id}/${att.id}`,
          mimeType: att.contentType || 'application/octet-stream',
          // NOTE (SDK audit): The SDK types only define { uri, mimeType } on attachments.
          // Adding filename/size as extra fields in metadata instead since the type
          // doesn't support them. Docs should mention this pattern.
        });
      }
    } catch {
      // Non-fatal — continue without attachments
    }
  }

  // Build from/to/cc header strings for metadata
  const fromStr = message.from ? formatRecipient(message.from) : undefined;
  const toStr = (message.toRecipients || []).map(formatRecipient).filter(Boolean).join(', ');
  const ccStr = (message.ccRecipients || []).map(formatRecipient).filter(Boolean).join(', ');

  return {
    sourceType: 'email',
    sourceId: `outlook-${message.id}`,
    timestamp: message.receivedDateTime || new Date().toISOString(),
    content: {
      text,
      participants,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        subject: message.subject,
        from: fromStr,
        to: toStr || undefined,
        cc: ccStr || undefined,
        messageId: message.internetMessageId,
        conversationId: message.conversationId,
        categories: message.categories,
        importance: message.importance,
        isRead: message.isRead,
      },
    },
  };
}
