import type { ConnectorDataEvent } from '@botmem/connector-sdk';
import type { IdentifierInput } from '../../people/people.service';

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function shouldMergeEntityResolutionBucket(
  entityType: string,
  role: string,
  bucket: { entityType: string; role: string; identifiers: IdentifierInput[] },
  identifiers: IdentifierInput[],
): boolean {
  if (bucket.entityType !== entityType || bucket.role !== role) return false;

  // Person entities must stay isolated. A single memory can mention several
  // people that share weak labels like "Amr" or "me"; fusing identifiers here
  // pollutes the person graph before PeopleService can evaluate evidence.
  if (entityType === 'person') return false;

  const bucketKeys = new Set(bucket.identifiers.map((id) => `${id.type}:${id.value}`));
  return identifiers.some((id) => bucketKeys.has(`${id.type}:${id.value}`));
}

export interface WhatsAppGroupIdentity {
  groupJid: string;
  groupName: string;
  groupIdentifiers: IdentifierInput[];
  members: Array<{
    rawJid?: string;
    identifiers: IdentifierInput[];
    confidence: number;
  }>;
}

function whatsappJidLocalPart(jid: string): string {
  return jid.split('@')[0]?.split(':')[0]?.trim() || '';
}

function normalizeWhatsAppPhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits.replace(/^\+/, '')}`;
}

function addWhatsAppMemberIdentifier(
  bucket: Map<string, WhatsAppGroupIdentity['members'][number]>,
  rawValue: string,
  connectorType: string,
) {
  const value = rawValue.trim();
  if (!value) return;

  const isJid = value.includes('@');
  const local = isJid ? whatsappJidLocalPart(value) : value;
  if (!local) return;

  let type = 'phone';
  let normalizedValue = normalizeWhatsAppPhone(local);
  let confidence = 0.95;

  if (value.endsWith('@lid')) {
    type = 'whatsapp_lid';
    normalizedValue = local.toLowerCase();
    confidence = 0.75;
  } else if (isJid && !value.endsWith('@s.whatsapp.net')) {
    return;
  }

  if (!normalizedValue) return;
  const key = `${type}:${normalizedValue}`;
  const existing = bucket.get(key);
  if (existing) {
    existing.rawJid ||= isJid ? value : undefined;
    existing.confidence = Math.max(existing.confidence, confidence);
    return;
  }

  bucket.set(key, {
    rawJid: isJid ? value : undefined,
    identifiers: [{ type, value: normalizedValue, connectorType }],
    confidence,
  });
}

export function buildWhatsAppGroupIdentity(
  event: ConnectorDataEvent,
  connectorType = 'whatsapp',
): WhatsAppGroupIdentity | null {
  const metadata = (event.content?.metadata || {}) as Record<string, unknown>;
  const groupJid = String(
    metadata.groupJid || event.sourceId.replace(/^wa-group:/, '') || '',
  ).trim();
  if (!groupJid || !groupJid.endsWith('@g.us')) return null;

  const groupName = String(metadata.name || metadata.groupName || groupJid).trim() || groupJid;
  const groupIdentifiers: IdentifierInput[] = [
    { type: 'whatsapp_group_jid', value: groupJid, connectorType },
  ];
  if (groupName && groupName !== groupJid) {
    groupIdentifiers.push({ type: 'name', value: groupName, connectorType });
  }

  const membersByIdentifier = new Map<string, WhatsAppGroupIdentity['members'][number]>();
  for (const value of arrayFromUnknown(metadata.memberJids)) {
    addWhatsAppMemberIdentifier(membersByIdentifier, String(value), connectorType);
  }
  for (const value of arrayFromUnknown(metadata.memberPhones)) {
    addWhatsAppMemberIdentifier(membersByIdentifier, String(value), connectorType);
  }
  for (const value of arrayFromUnknown(metadata.memberLids)) {
    addWhatsAppMemberIdentifier(membersByIdentifier, `${String(value)}@lid`, connectorType);
  }

  return {
    groupJid,
    groupName,
    groupIdentifiers,
    members: [...membersByIdentifier.values()],
  };
}
