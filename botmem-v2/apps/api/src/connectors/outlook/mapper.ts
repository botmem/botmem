import type { JsonValue, ProviderEventRevisionInput } from '@botmem-v2/connector-domain';
import type {
  OutlookAttachment,
  OutlookCryptoPort,
  OutlookMessage,
  OutlookRecipient,
} from './ports.js';

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toJsonValue(item)));
  }
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = toJsonValue(item);
    }
    return output;
  }
  return null;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(',')}}`;
}

function validTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizedEmail(recipient: OutlookRecipient | null | undefined): string | null {
  const address = recipient?.emailAddress?.address?.trim().toLowerCase();
  return address ? address : null;
}

function participants(message: OutlookMessage): readonly JsonValue[] {
  const output: JsonValue[] = [];
  const seen = new Set<string>();
  const add = (
    recipient: OutlookRecipient | null | undefined,
    role: 'sender' | 'recipient' | 'participant',
  ) => {
    const email = normalizedEmail(recipient);
    if (!email) return;
    const key = `${role}:${email}`;
    if (seen.has(key)) return;
    seen.add(key);
    const displayName = recipient?.emailAddress?.name?.trim();
    output.push({
      durableId: `email:${email}`,
      ...(displayName ? { displayName } : {}),
      role,
      identifiers: [{ kind: 'email', value: email }],
    });
  };

  add(message.from ?? message.sender, 'sender');
  if (message.sender && normalizedEmail(message.sender) !== normalizedEmail(message.from)) {
    add(message.sender, 'sender');
  }
  message.toRecipients?.forEach((recipient) => add(recipient, 'recipient'));
  message.ccRecipients?.forEach((recipient) => add(recipient, 'recipient'));
  message.bccRecipients?.forEach((recipient) => add(recipient, 'recipient'));
  message.replyTo?.forEach((recipient) => add(recipient, 'participant'));
  return Object.freeze(output);
}

function attachmentDescriptor(messageId: string, attachment: OutlookAttachment): JsonValue | null {
  const attachmentId = attachment.id?.trim();
  if (!attachmentId) return null;
  const fileName = attachment.name?.trim();
  const mimeType = attachment.contentType?.trim() || 'application/octet-stream';
  const size = attachment.size;
  return {
    durableId: `${messageId}:attachment:${attachmentId}`,
    mimeType,
    ...(fileName ? { fileName } : {}),
    ...(typeof size === 'number' && Number.isInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
    availability: 'hosted',
  };
}

function normalizedProjection(message: OutlookMessage): JsonValue {
  const title = message.subject?.trim();
  const body = message.body?.content ?? message.bodyPreview ?? '';
  const threadId = message.conversationId?.trim();
  const media = (message.attachments ?? [])
    .map((attachment) => attachmentDescriptor(message.id, attachment))
    .filter((attachment): attachment is JsonValue => attachment !== null);
  return {
    sourceId: message.id,
    ...(title ? { title } : {}),
    text: body,
    ...(threadId
      ? {
          thread: {
            durableId: `outlook-conversation:${threadId}`,
            ...(title ? { title } : {}),
          },
        }
      : {}),
    participants: participants(message),
    media,
  };
}

function revision(message: OutlookMessage, contentHash: string): string {
  const candidates = [
    ['changeKey', message.changeKey],
    ['etag', message['@odata.etag']],
    ['modified', message.lastModifiedDateTime],
  ] as const;
  for (const [prefix, value] of candidates) {
    const normalized = value?.trim();
    if (normalized && normalized.length <= 480) return `${prefix}:${normalized}`;
  }
  return `sha256:${contentHash}`;
}

export async function mapOutlookMessage(
  message: OutlookMessage,
  crypto: Pick<OutlookCryptoPort, 'sha256Hex'>,
): Promise<ProviderEventRevisionInput> {
  if (message['@removed']) {
    const payload: JsonValue = {
      schema: 'outlook.tombstone.v1',
      providerMessageId: message.id,
      reason: message['@removed'].reason?.trim() || 'removed',
    };
    const contentHash = await crypto.sha256Hex(canonicalJson(payload));
    return Object.freeze({
      sourceEventId: message.id,
      sourceRevision: `removed:sha256:${contentHash}`,
      kind: 'email',
      occurredAt: null,
      contentHash,
      payload,
      tombstone: true,
    });
  }

  const payload: JsonValue = {
    schema: 'outlook.message.v1',
    provider: toJsonValue(message),
    normalized: normalizedProjection(message),
  };
  const contentHash = await crypto.sha256Hex(canonicalJson(payload));
  return Object.freeze({
    sourceEventId: message.id,
    sourceRevision: revision(message, contentHash),
    kind: 'email',
    occurredAt:
      validTimestamp(message.receivedDateTime) ??
      validTimestamp(message.sentDateTime) ??
      validTimestamp(message.createdDateTime),
    contentHash,
    payload,
  });
}
