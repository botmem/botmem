import type { ConnectorDataEvent } from '@botmem/connector-sdk';
import type { IdentifierInput } from '../../people/people.service';

function compactStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizePhone(value: string): string | null {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

function normalizeLid(value: string): string | null {
  const lid = value.replace(/@.*$/, '').split(':')[0].trim();
  if (!lid || lid.includes('-')) return null;
  return lid;
}

export function buildWhatsAppContactIdentity(
  event: ConnectorDataEvent,
  connectorType: string,
): { identifiers: IdentifierInput[] } | null {
  const metadata = (event.content?.metadata || {}) as Record<string, unknown>;
  if (metadata.type !== 'contact' || metadata.isGroup === true) return null;

  const identifiers: IdentifierInput[] = [];
  const phones = compactStrings([
    ...(Array.isArray(metadata.phones) ? metadata.phones : []),
    metadata.phone,
    ...((event.content?.participants || []) as unknown[]),
  ]);
  const lids = compactStrings([
    ...(Array.isArray(metadata.whatsappLids) ? metadata.whatsappLids : []),
    metadata.whatsappLid,
  ]);

  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    if (normalized) identifiers.push({ type: 'phone', value: normalized, connectorType });
  }
  for (const lid of lids) {
    const normalized = normalizeLid(lid);
    if (normalized) identifiers.push({ type: 'whatsapp_lid', value: normalized, connectorType });
  }

  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  if (name) identifiers.push({ type: 'name', value: name, connectorType });

  return identifiers.some((identifier) => identifier.type !== 'name') ? { identifiers } : null;
}
