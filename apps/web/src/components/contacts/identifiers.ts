export interface ContactIdentifier {
  id?: string;
  type: string;
  value: string;
  isPrimary?: boolean;
}

const MACHINE_IDENTIFIER_TYPES = new Set([
  'apple_contact_id',
  'immich_person_id',
  'photos_person_id',
  'whatsapp_lid',
]);

export function identifierKey(ident: Pick<ContactIdentifier, 'type' | 'value'>): string {
  const value = ident.value.trim().toLowerCase();
  const digits = value.replace(/\D/g, '');
  if (
    ident.type === 'whatsapp_group_jid' ||
    (ident.type === 'phone' && digits.startsWith('120363') && digits.length >= 15)
  ) {
    return `whatsapp_group:${digits || value.replace(/@.*/, '')}`;
  }
  return `${ident.type}:${value}`;
}

export function dedupeIdentifiers<T extends ContactIdentifier>(identifiers: T[]): T[] {
  const seen = new Set<string>();
  return identifiers.filter((ident) => {
    const key = identifierKey(ident);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isMachineIdentifier(ident: Pick<ContactIdentifier, 'type' | 'value'>): boolean {
  return (
    MACHINE_IDENTIFIER_TYPES.has(ident.type.toLowerCase()) ||
    (ident.type.toLowerCase() === 'whatsapp_jid' && ident.value.includes('@lid'))
  );
}

export function visibleIdentifierBadges<T extends ContactIdentifier>(
  identifiers: T[],
  maxBadges: number,
): { shown: T[]; extraCount: number } {
  const deduped = dedupeIdentifiers(identifiers);
  const preferred = deduped.filter((ident) => !isMachineIdentifier(ident));
  const overflow = deduped.length - Math.min(preferred.length, maxBadges);
  return { shown: preferred.slice(0, maxBadges), extraCount: overflow };
}
