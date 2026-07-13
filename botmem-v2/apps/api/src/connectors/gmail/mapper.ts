import type { JsonValue, ProviderEventRevisionInput } from '@botmem-v2/connector-domain';
import type { GmailCryptoPort, GmailMessage } from './ports.js';

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toJsonValue(item)));
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = toJsonValue(item);
      }
    }
    return output;
  }
  return null;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(',')}}`;
}

function occurredAt(message: GmailMessage): string | null {
  if (message.internalDate && /^\d+$/.test(message.internalDate)) {
    const timestamp = new Date(Number(message.internalDate));
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  const dateHeader = message.payload?.headers?.find(
    (header) => header.name?.toLowerCase() === 'date',
  )?.value;
  if (dateHeader) {
    const timestamp = new Date(dateHeader);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  return null;
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers
    ?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase())
    ?.value?.trim();
}

function decodedBody(part: NonNullable<GmailMessage['payload']>): string {
  const own = part.body?.data ? decodeBase64Url(part.body.data) : '';
  const children = part.parts ?? [];
  const plain = children
    .filter((child) => child.mimeType?.toLowerCase().startsWith('text/plain'))
    .map(decodedBody)
    .filter(Boolean);
  if (plain.length > 0) return plain.join('\n');
  const nested = children.map(decodedBody).filter(Boolean);
  if (nested.length > 0) return nested.join('\n');
  return part.mimeType?.toLowerCase().startsWith('text/html') ? htmlToText(own) : own;
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8').replaceAll('\u0000', '');
  } catch {
    return '';
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[\t ]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function participants(message: GmailMessage): readonly JsonValue[] {
  const output: JsonValue[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined, role: 'sender' | 'recipient' | 'participant') => {
    if (!value) return;
    for (const match of value.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) {
      const email = match[0].normalize('NFKC').toLowerCase();
      const key = `${role}:${email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        durableId: `email:${email}`,
        role,
        identifiers: [{ kind: 'email', value: email }],
      });
    }
  };
  add(header(message, 'from'), 'sender');
  add(header(message, 'sender'), 'sender');
  add(header(message, 'to'), 'recipient');
  add(header(message, 'cc'), 'recipient');
  add(header(message, 'bcc'), 'recipient');
  add(header(message, 'reply-to'), 'participant');
  return Object.freeze(output);
}

function attachments(message: GmailMessage): readonly JsonValue[] {
  const output: JsonValue[] = [];
  const visit = (part: NonNullable<GmailMessage['payload']>) => {
    const fileName = part.filename?.trim();
    const attachmentId = part.body?.attachmentId?.trim();
    if (fileName || attachmentId) {
      const durablePart = attachmentId || part.partId?.trim();
      if (durablePart) {
        output.push({
          durableId: `${message.id}:attachment:${durablePart}`,
          mimeType: part.mimeType?.trim() || 'application/octet-stream',
          ...(fileName ? { fileName } : {}),
          ...(Number.isInteger(part.body?.size) && (part.body?.size ?? -1) >= 0
            ? { sizeBytes: part.body?.size ?? 0 }
            : {}),
          availability: 'hosted',
        });
      }
    }
    part.parts?.forEach(visit);
  };
  if (message.payload) visit(message.payload);
  return Object.freeze(output);
}

function normalizedProjection(message: GmailMessage): JsonValue {
  const title = header(message, 'subject');
  const body = (message.payload ? decodedBody(message.payload) : '') || message.snippet || '';
  return {
    sourceId: message.id,
    ...(title ? { title } : {}),
    text: body,
    ...(message.threadId
      ? {
          thread: {
            durableId: `gmail-thread:${message.threadId}`,
            ...(title ? { title } : {}),
          },
        }
      : {}),
    participants: participants(message),
    media: attachments(message),
    authoredByMe: message.labelIds?.includes('SENT') ?? false,
  };
}

export async function mapGmailMessage(
  message: GmailMessage,
  crypto: Pick<GmailCryptoPort, 'sha256Hex'>,
): Promise<ProviderEventRevisionInput> {
  const payload: JsonValue = {
    schema: 'gmail.message.v1',
    provider: toJsonValue(message),
    normalized: normalizedProjection(message),
  };
  const contentHash = await crypto.sha256Hex(canonicalJson(payload));
  return Object.freeze({
    sourceEventId: message.id,
    sourceRevision: message.historyId ? `history:${message.historyId}` : `sha256:${contentHash}`,
    kind: 'email',
    occurredAt: occurredAt(message),
    contentHash,
    payload,
  });
}

export async function mapGmailTombstone(
  messageId: string,
  historyRecordId: string,
  crypto: Pick<GmailCryptoPort, 'sha256Hex'>,
): Promise<ProviderEventRevisionInput> {
  const payload: JsonValue = {
    schema: 'gmail.tombstone.v1',
    providerMessageId: messageId,
    historyRecordId,
  };
  return Object.freeze({
    sourceEventId: messageId,
    sourceRevision: `history:${historyRecordId}:deleted`,
    kind: 'email',
    occurredAt: null,
    contentHash: await crypto.sha256Hex(canonicalJson(payload)),
    payload,
    tombstone: true,
  });
}
