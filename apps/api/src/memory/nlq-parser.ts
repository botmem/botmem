// eslint-disable-next-line @typescript-eslint/no-require-imports
const nlp = require('compromise/three');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plg = require('compromise-dates');

nlp.plugin(plg);

export interface NlqParsed {
  temporal: { from: string; to: string } | null;
  temporalText: string | null;
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;
  sourceTypeHint: string | null;
}

interface TemporalResult {
  range: { from: string; to: string };
  text: string;
}

const DANGLING = /\s+(?:in|from|during|between|since|before|after|on|only)\s*$/i;
const LEADING_PREPS = /^(?:from|in|during|since|before|after|on)\s+/i;

// --- Intent patterns (ordered: first match wins) ---

const FIND_PATTERNS = [
  /\b\w+'s\s+(phone|email|number|address|birthday)/i,
  /^find\b/i,
  /\b(phone|email|number|address)\s+(of|for)\b/i,
];

const BROWSE_PATTERNS = [
  /^(show|list|browse)\b/i,
  /\brecent\b/i,
  /^(my|all)\s+(photos?|emails?|messages?)/i,
];

const RECALL_PATTERNS = [
  /^(what|who|when|where|how|why)\s+(did|was|were|is|said)/i,
  /\btell\s+me\s+(about|what)/i,
];

// --- Source type patterns ---

const SOURCE_TYPE_MAP: [RegExp, string][] = [
  [/\bphotos?\b/i, 'photo'],
  [/\bemails?\b/i, 'email'],
  [/\bmessages?\b/i, 'message'],
];

/**
 * Extract the local date/time from a compromise-dates string and treat it as UTC.
 * compromise-dates returns "2026-03-02T00:00:00.000+04:00" — we want "2026-03-02T00:00:00.000Z"
 * because our system stores all dates in UTC and the user means "that calendar day".
 */
function localToUTC(dateStr: string): string {
  // Strip timezone offset, replace with Z
  return dateStr.replace(/[+-]\d{2}:\d{2}$/, 'Z');
}

/**
 * If the parsed range is entirely in the future and looks like a month-only
 * reference (duration ~1 month), shift it back one year to prefer "most recent past".
 */
function preferPast(
  range: { start: string; end: string; duration?: { months?: number } },
  now: Date,
): { from: string; to: string } {
  let from = localToUTC(range.start);
  let to = localToUTC(range.end);

  if (new Date(from) > now && range.duration?.months === 1) {
    from = from.replace(/^\d{4}/, String(new Date(from).getUTCFullYear() - 1));
    to = to.replace(/^\d{4}/, String(new Date(to).getUTCFullYear() - 1));
  }

  return { from, to };
}

/**
 * Parse temporal references from a query using compromise-dates.
 * Returns a date range and the matched text, or null.
 */
function parseTemporal(query: string, refDate: Date): TemporalResult | null {
  const doc = nlp(query);
  const dates = doc.dates();
  const dateText = dates.text().trim();

  if (!dateText) return null;

  // Strip leading preposition that confuses compromise-dates re-parse
  const cleaned = dateText.replace(LEADING_PREPS, '');
  if (!cleaned) return null;

  const parsed = nlp(cleaned).dates().get();
  if (!parsed.length) return null;

  const result = parsed[0];
  if (!result.start) return null;

  const range = preferPast(result, refDate);

  return { range, text: dateText };
}

function classifyIntent(query: string): 'recall' | 'browse' | 'find' {
  for (const pat of FIND_PATTERNS) {
    if (pat.test(query)) return 'find';
  }
  for (const pat of BROWSE_PATTERNS) {
    if (pat.test(query)) return 'browse';
  }
  for (const pat of RECALL_PATTERNS) {
    if (pat.test(query)) return 'recall';
  }
  return 'recall';
}

function detectSourceType(query: string): string | null {
  for (const [pat, type] of SOURCE_TYPE_MAP) {
    if (pat.test(query)) return type;
  }
  return null;
}

function buildCleanQuery(originalQuery: string, temporalText: string | null): string {
  if (!temporalText) return originalQuery;

  let clean = originalQuery.replace(temporalText, ' ').replace(/\s{2,}/g, ' ').trim();
  clean = clean.replace(DANGLING, '').trim();

  return clean || originalQuery;
}

/**
 * Main NLQ parser entry point. Pure function, no async dependencies.
 */
export function parseNlq(query: string, refDate?: Date): NlqParsed {
  const ref = refDate ?? new Date();

  const temporal = parseTemporal(query, ref);
  const intent = classifyIntent(query);
  const sourceTypeHint = detectSourceType(query);
  const temporalText = temporal?.text ?? null;
  const cleanQuery = buildCleanQuery(query, temporalText);

  return {
    temporal: temporal?.range ?? null,
    temporalText,
    intent,
    cleanQuery,
    sourceTypeHint,
  };
}
