import * as chrono from 'chrono-node';

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

const DANGLING_PREPS = /\s+(?:in|from|during|between|since|before|after|on)\s*$/i;

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

// --- UTC date helpers ---

function startOfDayUTC(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

function endOfDayUTC(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(23, 59, 59, 999);
  return r;
}

function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonthUTC(d: Date): Date {
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  lastDay.setUTCHours(23, 59, 59, 999);
  return lastDay;
}

/**
 * Handle "last week" specially: returns previous Monday 00:00 to Sunday 23:59 UTC.
 */
function parseLastWeek(refDate: Date): TemporalResult {
  // Get current day of week (0=Sun, 1=Mon, ..., 6=Sat)
  const dow = refDate.getUTCDay();
  // Days since last Monday: if Sunday (0) -> 6, Mon (1) -> 0, Tue (2) -> 1, etc.
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  // Previous week's Monday = this week's Monday - 7
  const prevMonday = new Date(refDate);
  prevMonday.setUTCDate(prevMonday.getUTCDate() - daysSinceMonday - 7);
  prevMonday.setUTCHours(0, 0, 0, 0);

  const prevSunday = new Date(prevMonday);
  prevSunday.setUTCDate(prevSunday.getUTCDate() + 6);
  prevSunday.setUTCHours(23, 59, 59, 999);

  return {
    range: { from: prevMonday.toISOString(), to: prevSunday.toISOString() },
    text: 'last week',
  };
}

/**
 * Handle "between X and Y" by finding two separate month/date references.
 */
function parseBetween(
  query: string,
  refDate: Date,
): TemporalResult | null {
  const match = query.match(/between\s+(.+?)\s+and\s+(.+?)(?:\s|$)/i);
  if (!match) return null;

  const results = chrono.parse(query, refDate);
  if (results.length < 2) return null;

  const startResult = results[0];
  const endResult = results[1];

  if (!startResult.start.isCertain('month') || !endResult.start.isCertain('month')) {
    return null;
  }

  let from = startResult.start.date();
  let to = endResult.start.date();

  // Expand to month boundaries
  if (!startResult.start.isCertain('day')) {
    from = startOfMonthUTC(from);
  } else {
    from = startOfDayUTC(from);
  }

  if (!endResult.start.isCertain('day')) {
    to = endOfMonthUTC(to);
  } else {
    to = endOfDayUTC(to);
  }

  // Reconstruct the matched text from the two chrono results
  const fullText = query.substring(
    query.toLowerCase().indexOf('between'),
    endResult.index + endResult.text.length,
  );

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    text: fullText,
  };
}

/**
 * Parse temporal references from a query string using chrono-node.
 * Only accepts high-confidence parses (month or day must be certain).
 */
function parseTemporal(query: string, refDate: Date): TemporalResult | null {
  // Special case: "last week" -> proper Mon-Sun boundaries
  if (/\blast\s+week\b/i.test(query)) {
    return parseLastWeek(refDate);
  }

  // Special case: "between X and Y"
  if (/\bbetween\b/i.test(query)) {
    const betweenResult = parseBetween(query, refDate);
    if (betweenResult) return betweenResult;
  }

  const results = chrono.parse(query, refDate);
  if (results.length === 0) return null;

  const result = results[0];

  // Confidence check: reject low-confidence parses
  const startCertain =
    result.start.isCertain('month') || result.start.isCertain('day');
  if (!startCertain) return null;

  let from: Date;
  let to: Date;

  if (result.end) {
    // Explicit range (e.g., "from March to June")
    from = result.start.date();
    to = result.end.date();

    if (!result.start.isCertain('day')) {
      from = startOfMonthUTC(from);
    } else {
      from = startOfDayUTC(from);
    }

    if (result.end.isCertain('month') && !result.end.isCertain('day')) {
      to = endOfMonthUTC(to);
    } else {
      to = endOfDayUTC(to);
    }
  } else {
    // Single point
    from = result.start.date();
    if (result.start.isCertain('month') && !result.start.isCertain('day')) {
      // Month-only reference (e.g., "in January") -- expand to full month
      from = startOfMonthUTC(from);
      to = endOfMonthUTC(from);
    } else {
      // Specific day reference -- expand to end of day
      to = endOfDayUTC(from);
      from = startOfDayUTC(from);
    }
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    text: result.text,
  };
}

/**
 * Classify user intent from the query string.
 */
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

/**
 * Detect source type hint from query keywords.
 */
function detectSourceType(query: string): string | null {
  for (const [pat, type] of SOURCE_TYPE_MAP) {
    if (pat.test(query)) return type;
  }
  return null;
}

/**
 * Strip temporal tokens and dangling prepositions from the query.
 */
function buildCleanQuery(
  originalQuery: string,
  temporalText: string | null,
): string {
  if (!temporalText) return originalQuery;

  // Remove the temporal text
  let clean = originalQuery.replace(temporalText, '').trim();

  // Strip dangling prepositions at the end
  clean = clean.replace(DANGLING_PREPS, '').trim();

  // If nothing left, fall back to original
  if (!clean) return originalQuery;

  return clean;
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
    temporal: temporal ? { from: temporal.range.from, to: temporal.range.to } : null,
    temporalText,
    intent,
    cleanQuery,
    sourceTypeHint,
  };
}
