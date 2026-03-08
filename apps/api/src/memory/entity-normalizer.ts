/**
 * Entity normalizer — pure function that validates, cleans, deduplicates,
 * and caps entities extracted from LLM or connector output.
 */

export const CANONICAL_ENTITY_TYPES = [
  'person',
  'organization',
  'location',
  'date',
  'event',
  'product',
  'concept',
  'quantity',
  'language',
  'other',
] as const;

export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

export interface NormalizedEntity {
  type: CanonicalEntityType;
  value: string;
}

/** Maps hallucinated or legacy types to canonical types. */
export const TYPE_MAP: Record<string, CanonicalEntityType> = {
  topic: 'concept',
  pet: 'other',
  group: 'organization',
  device: 'product',
  greeting: 'other',
  schedule: 'event',
  time: 'date',
  amount: 'quantity',
  metric: 'quantity',
  currency: 'quantity',
  email: 'other',
  url: 'other',
};

const canonicalSet = new Set<string>(CANONICAL_ENTITY_TYPES);

const PRONOUNS = new Set([
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'mine',
  'yours',
  'hers',
  'ours',
  'theirs',
  'myself',
  'yourself',
  'himself',
  'herself',
  'itself',
  'ourselves',
  'themselves',
]);

const GENERIC_TERMS = new Set([
  'hello',
  'hi',
  'hey',
  'thanks',
  'thank',
  'bye',
  'ok',
  'okay',
  'yes',
  'no',
  'maybe',
  'sure',
  'please',
  'the',
  'a',
  'an',
  'this',
  'that',
]);

const URL_RE = /^https?:\/\//i;

/**
 * Extract value from an embed-shape entity's compound id field.
 * Format: "name:John Smith|email:john@x.com" -> "John Smith"
 */
function extractValueFromId(id: string): string {
  if (id.includes(':') && id.includes('|')) {
    // Compound format — extract name part
    const nameMatch = id.match(/^name:([^|]+)/);
    if (nameMatch) return nameMatch[1];
  }
  return id;
}

function isGarbage(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return true;
  const lower = trimmed.toLowerCase();
  if (PRONOUNS.has(lower)) return true;
  if (GENERIC_TERMS.has(lower)) return true;
  if (URL_RE.test(trimmed)) return true;
  return false;
}

/**
 * Normalize a raw entity array into canonical form.
 *
 * Handles both enrich-shape ({type, value}) and embed-shape ({type, id, role}).
 * Strips garbage, maps types, deduplicates, and caps count.
 */
export function normalizeEntities(
  raw: Array<Record<string, string>>,
  maxEntities = 30,
): NormalizedEntity[] {
  const seen = new Set<string>();
  const result: NormalizedEntity[] = [];

  for (const entity of raw) {
    // Extract value from various shapes
    let value = entity.value ?? entity.name ?? '';
    if (!value && entity.id) {
      value = extractValueFromId(entity.id);
    }

    value = value.trim();
    if (!value || isGarbage(value)) continue;

    // Map type to canonical
    const rawType = (entity.type ?? 'other').toLowerCase();
    const type: CanonicalEntityType = TYPE_MAP[rawType]
      ?? (canonicalSet.has(rawType) ? (rawType as CanonicalEntityType) : 'other');

    // Deduplicate by type::lowercaseValue
    const key = `${type}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ type, value });
    if (result.length >= maxEntities) break;
  }

  return result;
}
