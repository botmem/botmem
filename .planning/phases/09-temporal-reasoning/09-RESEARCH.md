# Phase 9: NLQ Parsing - Research

**Researched:** 2026-03-08
**Domain:** Natural language query parsing (temporal, entity, intent) for memory search
**Confidence:** HIGH

## Summary

Phase 9 adds deterministic natural language query parsing to the existing search pipeline. The core requirement is that all parsing happens without LLM calls (PERF-01: <500ms). The implementation involves three parsing stages: (1) temporal extraction via chrono-node, (2) entity resolution via the existing greedy span matcher, and (3) rule-based intent classification. All three feed into a `parsed` response field and modify the search behavior (date filtering, result limits, weight adjustments).

The existing `MemoryService.search()` at `memory.service.ts:176` already has entity-aware hybrid search with `resolveEntities()`, FTS5 text search, Qdrant vector search, and a multi-signal scoring formula. The NLQ parser slots in **before** the existing pipeline: it extracts temporal references and intent from the raw query, strips temporal tokens to produce a `cleanQuery`, then passes that cleaned query plus temporal filters into the existing search flow.

**Primary recommendation:** Create a standalone `NlqParser` service (pure functions, no dependencies on DB/Qdrant) that takes a raw query string and returns `{ temporal, intent, cleanQuery, temporalTokens }`. Integrate it at the top of `MemoryService.search()` before entity resolution and embedding.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Use chrono-node for all temporal extraction (locked by PERF-01)
- Ambiguous month/season references resolve to the most recent past occurrence ("January" in March 2026 = January 2026)
- Support both simple references ("last week", "yesterday", "in January") AND explicit ranges ("between March and June", "from Jan to Mar")
- Temporal filters are strict: only return memories within the parsed date range
- When strict temporal filter returns zero results, fallback to unfiltered search with `fallback: true` and `parsed.temporalFallback: true`
- Confidence threshold on chrono-node output: only apply temporal filter for high-confidence parses; low-confidence parses are ignored and words stay in semantic query
- API response includes a new top-level `parsed` field: `{ temporal: {from, to} | null, entities: [...], intent: "recall"|"browse"|"find", cleanQuery: "..." }`
- Existing `resolvedEntities` field kept for backward compatibility
- The cleaned query (temporal/entity references stripped) is used for the semantic embedding
- CLI (`botmem search`) runs NLQ parsing on every query by default
- Rule-based deterministic keyword/pattern matching for intent (no LLM):
  - "what did"/"who said"/"tell me about" -> recall
  - "show me"/"list"/"recent" -> browse
  - "find"/possessive "'s" -> find
- Default intent: recall
- Find intent: top 5 results with strict entity matching
- Recall intent: default 20 results with broad semantic matching
- Browse intent: boosts recency weight significantly, filters by sourceType if detectable
- AND logic for combo queries: both temporal and entity filters apply simultaneously
- No temporal references detected -> silent passthrough, `parsed.temporal` is null
- Parse feedback displayed in existing search result box (no new chip/tag UI components)

### Claude's Discretion
- Exact chrono-node confidence threshold value
- How to strip temporal tokens from the query string before embedding
- Internal architecture of the NLQ parser module (single function vs service class)
- Exact keyword patterns for intent classification rules
- How browse intent adjusts the scoring formula weights

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| NLQ-01 | User can search with temporal references and get date-filtered results via chrono-node | chrono-node v2.9 API, Qdrant datetime range filters, `buildQdrantFilter` extension, SQLite WHERE on eventTime |
| NLQ-02 | User can search with person/place/org names and get entity-boosted results | Existing `resolveEntities()` already handles this; NLQ parser feeds cleaned query to it; `parsed.entities` surfaces resolved entities in new response shape |
| NLQ-03 | Search classifies query intent (recall/browse/find) to optimize result ranking | Rule-based regex patterns on query string; browse adjusts scoring weights; find limits results to top 5 |
| PERF-01 | Search with NLQ enhancements completes in <500ms (no LLM calls in search hot path) | chrono-node parse is ~1ms synchronous; regex intent match is ~0.01ms; no new async calls added to hot path |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| chrono-node | 2.9.x | Natural language date parsing | Locked by user decision. TypeScript, zero deps, ~1ms parse time, supports en locale with casual/strict modes |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | Intent classification is pure regex | No library needed for keyword pattern matching |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| chrono-node | date-fns/parse | chrono-node handles natural language; date-fns only parses structured formats |
| Rule-based intent | compromise (NLP) | 200KB+ library for simple keyword matching; overkill |

**Installation:**
```bash
cd apps/api && pnpm add chrono-node
```

## Architecture Patterns

### Recommended Module Structure
```
apps/api/src/memory/
  nlq-parser.ts          # Pure NLQ parsing functions (temporal, intent, token stripping)
  memory.service.ts      # Search method updated to call NLQ parser first
  qdrant.service.ts      # (unchanged, already supports filter param)
```

### Pattern 1: NLQ Parser as Pure Functions
**What:** A stateless module exporting `parseNlq(query: string, referenceDate?: Date)` that returns the full parsed structure. No NestJS injectable needed since it has no dependencies.
**When to use:** Every search call.
**Example:**
```typescript
// apps/api/src/memory/nlq-parser.ts

import * as chrono from 'chrono-node';

export interface NlqParsed {
  temporal: { from: string; to: string } | null;
  temporalText: string | null;        // The matched temporal phrase (for stripping)
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;                  // Query with temporal tokens removed
  sourceTypeHint: string | null;       // Detected sourceType from browse queries
}

export function parseNlq(query: string, refDate: Date = new Date()): NlqParsed {
  const temporal = parseTemporal(query, refDate);
  const intent = classifyIntent(query);
  const sourceTypeHint = detectSourceType(query);

  // Strip temporal tokens from query for cleaner embedding
  let cleanQuery = query;
  if (temporal?.text) {
    cleanQuery = query.replace(temporal.text, '').replace(/\s+/g, ' ').trim();
  }

  return {
    temporal: temporal?.range ?? null,
    temporalText: temporal?.text ?? null,
    intent,
    cleanQuery: cleanQuery || query, // Fallback to original if stripping empties it
    sourceTypeHint,
  };
}
```

### Pattern 2: Temporal Parsing with Confidence Check
**What:** Use chrono-node's `parse()` (not `parseDate()`) to get `ParsedResult[]` with positional info and `isCertain()` checks.
**When to use:** For temporal extraction with confidence filtering.
**Example:**
```typescript
interface TemporalResult {
  range: { from: string; to: string };
  text: string;  // The matched text span for stripping
}

function parseTemporal(query: string, refDate: Date): TemporalResult | null {
  const results = chrono.parse(query, refDate);
  if (results.length === 0) return null;

  const result = results[0]; // Take first (most prominent) temporal reference

  // Confidence check: require at least month-level certainty
  // isCertain('month') returns true for "last week", "January", "yesterday"
  // but false for ambiguous parses like a bare number "5"
  const startCertain = result.start.isCertain('month') || result.start.isCertain('day');
  if (!startCertain) return null;

  const from = result.start.date().toISOString();
  const to = result.end ? result.end.date().toISOString() : inferEndDate(result);

  return {
    range: { from, to },
    text: result.text,
  };
}

// For "last week" chrono gives start+end. For "January" it gives just a day.
// We need to expand single-point references to ranges.
function inferEndDate(result: chrono.ParsedResult): string {
  const start = result.start;
  // If only month is certain (not day), expand to full month
  if (start.isCertain('month') && !start.isCertain('day')) {
    const d = new Date(start.date());
    d.setMonth(d.getMonth() + 1);
    d.setDate(0); // Last day of the original month
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }
  // Single day: expand to end of that day
  const d = new Date(start.date());
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
```

### Pattern 3: Intent Classification via Regex
**What:** Ordered regex patterns against the raw query. First match wins.
**Example:**
```typescript
const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: 'recall' | 'browse' | 'find' }> = [
  // Find: possessive, "find", direct lookup
  { pattern: /\b\w+'s\s+(phone|email|number|address|birthday)/i, intent: 'find' },
  { pattern: /^find\b/i, intent: 'find' },
  { pattern: /\b(phone|email|number|address)\s+(of|for)\b/i, intent: 'find' },

  // Browse: listing, showing, recent
  { pattern: /^(show|list|browse)\b/i, intent: 'browse' },
  { pattern: /\brecent\b/i, intent: 'browse' },
  { pattern: /^(my|all)\s+(photos?|emails?|messages?)/i, intent: 'browse' },

  // Recall: question words, tell me about
  { pattern: /^(what|who|when|where|how|why)\s+(did|was|were|is|said)/i, intent: 'recall' },
  { pattern: /\btell\s+me\s+(about|what)/i, intent: 'recall' },
];

function classifyIntent(query: string): 'recall' | 'browse' | 'find' {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(query)) return intent;
  }
  return 'recall'; // Default
}
```

### Pattern 4: Browse Intent Weight Adjustment
**What:** When intent is `browse`, increase recency weight in scoring formula from 0.15 to 0.40 (redistributing from semantic).
**Recommendation for discretion area:**
```
Normal:  0.70 semantic + 0.15 recency + 0.10 importance + 0.05 trust
Browse:  0.40 semantic + 0.40 recency + 0.15 importance + 0.05 trust
```
This heavily favors recent memories while still maintaining semantic relevance.

### Pattern 5: Qdrant Temporal Filter Integration
**What:** Extend `buildQdrantFilter()` to add `event_time` range condition.
**Example:**
```typescript
private buildQdrantFilter(filters: SearchFilters): Record<string, unknown> {
  const must: any[] = [];
  if (filters.sourceType) {
    must.push({ key: 'source_type', match: { value: filters.sourceType } });
  }
  if (filters.connectorType) {
    must.push({ key: 'connector_type', match: { value: filters.connectorType } });
  }
  // Temporal range filter
  if (filters.from || filters.to) {
    const range: Record<string, string> = {};
    if (filters.from) range.gte = filters.from;
    if (filters.to) range.lte = filters.to;
    must.push({ key: 'event_time', range });
  }
  return must.length ? { must } : {};
}
```

### Anti-Patterns to Avoid
- **LLM-based intent classification:** Violates PERF-01. The regex approach runs in microseconds.
- **Parsing temporal from cleaned query:** Parse temporal from the ORIGINAL query before any modifications, then strip tokens for the clean query.
- **Multiple temporal references:** Take only the first (most prominent) chrono result. Combining multiple temporal references adds complexity with little value.
- **Removing entity words from query before chrono:** Entity resolution and temporal parsing are independent; both operate on the original query.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date parsing from "last week", "January", "yesterday" | Custom regex date parser | chrono-node | Handles dozens of formats, relative dates, ranges, locale-aware, battle-tested |
| Month-end calculation | Manual day counting | `new Date(year, month+1, 0)` | JS Date handles leap years, month lengths |
| ISO 8601 formatting | String concatenation | `Date.toISOString()` | Correct timezone handling |

**Key insight:** chrono-node handles the full complexity of temporal NLP (relative dates, named months, ranges, ordinals, "the 3rd of March") in a single synchronous call. Any custom parser would be orders of magnitude less capable.

## Common Pitfalls

### Pitfall 1: Temporal Token Stripping Leaves Orphaned Prepositions
**What goes wrong:** "emails from last week" -> stripping "last week" leaves "emails from" with a dangling "from".
**Why it happens:** chrono-node's `result.text` captures "last week" but not the preceding preposition.
**How to avoid:** After stripping the temporal text, also strip common preceding prepositions (in, from, during, between, since, before, after, on) if they appear immediately before the temporal match position.
**Warning signs:** Clean queries ending in prepositions ("emails from", "photos in").

### Pitfall 2: "January" Resolving to Wrong Year
**What goes wrong:** In March 2026, "January" could mean Jan 2026 or Jan 2027.
**Why it happens:** chrono-node defaults to forward-looking dates when `forwardDate` option is true.
**How to avoid:** Do NOT set `forwardDate: true`. chrono-node's default behavior with a reference date of `new Date()` already resolves "January" to the most recent past January when the current month is after January. Verify with tests.
**Warning signs:** Future dates in temporal filters.

### Pitfall 3: Qdrant event_time Not Indexed
**What goes wrong:** Temporal range filter on `event_time` does a full scan instead of indexed lookup, making search slow.
**Why it happens:** No payload index exists for `event_time` in the current Qdrant setup.
**How to avoid:** Create a datetime payload index on `event_time` in `QdrantService.onModuleInit()`:
```typescript
await this.client.createPayloadIndex(QdrantService.COLLECTION, {
  field_name: 'event_time',
  field_schema: 'datetime',
});
```
**Warning signs:** Search with temporal filter takes >200ms more than without.

### Pitfall 4: Empty Clean Query After Stripping
**What goes wrong:** Query is purely temporal like "last week" -> clean query becomes empty -> embedding fails or returns garbage.
**Why it happens:** Entire query was temporal tokens.
**How to avoid:** If cleanQuery is empty after stripping, fall back to the original query for embedding. The temporal filter will do the heavy lifting.
**Warning signs:** Empty string passed to `ollama.embed()`.

### Pitfall 5: Browse Intent Overriding Explicit sourceType Filter
**What goes wrong:** User passes `--source photo` AND query contains "photos" -> double filtering or conflicting filters.
**Why it happens:** NLQ parser detects "photos" as sourceType hint, but explicit filter already set.
**How to avoid:** Explicit filters from the request body take precedence over NLQ-inferred filters. Only apply sourceTypeHint when no explicit sourceType filter is provided.

### Pitfall 6: chrono-node Matching Contact Names as Dates
**What goes wrong:** "June" (a person's name) gets parsed as the month of June.
**Why it happens:** chrono-node doesn't know about contacts.
**How to avoid:** Run entity resolution FIRST. If "June" resolves to a contact, exclude it from temporal parsing by replacing it with a placeholder before passing to chrono-node. Alternatively, run both in parallel and if a token is claimed by both entity resolution and chrono-node, prefer entity resolution (contacts are more specific than generic month names).
**Warning signs:** Queries about people named after months/days producing unexpected date filters.

## Code Examples

### Integration Point: Updated search() Method
```typescript
async search(query: string, filters?: SearchFilters, limit = 20, rerank = false): Promise<SearchResponse> {
  if (!query.trim()) return { items: [], fallback: false };

  // Step 1: NLQ parsing (deterministic, <1ms)
  const parsed = parseNlq(query);

  // Step 2: Apply temporal filters
  const effectiveFilters: SearchFilters = { ...filters };
  if (parsed.temporal) {
    effectiveFilters.from = parsed.temporal.from;
    effectiveFilters.to = parsed.temporal.to;
  }
  if (parsed.sourceTypeHint && !filters?.sourceType) {
    effectiveFilters.sourceType = parsed.sourceTypeHint;
  }

  // Step 3: Apply intent-based limits
  const effectiveLimit = parsed.intent === 'find' ? 5 : limit;

  // Step 4: Use cleanQuery for embedding (temporal tokens stripped)
  const embedQuery = parsed.cleanQuery;

  // ... rest of existing search logic using embedQuery and effectiveFilters ...

  // Step 5: If temporal filter returns 0 results, retry without temporal
  if (parsed.temporal && results.length === 0) {
    // Retry without temporal filter
    const retryFilters = { ...filters }; // Original filters, no temporal
    // ... re-run search ...
    return { items: retryItems, fallback: true, parsed: { ...parsedResponse, temporalFallback: true } };
  }

  return { items: finalItems, fallback: !hasExactMatches, resolvedEntities, parsed: parsedResponse };
}
```

### SearchFilters Interface Extension
```typescript
interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  factualityLabel?: string;
  from?: string;  // ISO 8601 datetime
  to?: string;    // ISO 8601 datetime
}
```

### SearchResponse Interface Extension
```typescript
interface ParsedQuery {
  temporal: { from: string; to: string } | null;
  temporalFallback?: boolean;
  entities: { id: string; displayName: string }[];
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;
}

interface SearchResponse {
  items: SearchResult[];
  fallback: boolean;
  resolvedEntities?: ResolvedEntities;  // Kept for backward compatibility
  parsed?: ParsedQuery;                  // New NLQ parse output
}
```

### CLI Integration (Transparent NLQ)
The CLI already sends the raw query to `POST /memories/search`. NLQ parsing happens server-side, so the CLI gets `parsed` in the response automatically. The only CLI change is displaying the `parsed` field in `--json` mode (already included in response) and showing temporal info in the search banner for human-readable output.

### Frontend Integration (SearchResultsBanner Extension)
```typescript
// Extend SearchResultsBanner to show temporal parse info
if (parsed?.temporal) {
  // "Showing results from Jan 1 - Jan 31, 2026"
}
if (parsed?.temporalFallback) {
  // "No results for last Tuesday -- showing all matches"
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| LLM-based query understanding | Deterministic NLQ parsing | chrono-node has been stable since v2.x (2021+) | Sub-millisecond parse time, no API dependency |
| Single search mode | Intent-based result tuning | Common in modern search UIs | Better precision for "find" queries, better recency for "browse" |

**Deprecated/outdated:**
- chrono-node v1.x: Replaced by v2.x with full TypeScript rewrite and new Parser/Refiner interfaces. Use v2.9.x.

## Open Questions

1. **Contact name vs month name collision handling**
   - What we know: chrono-node will parse "June" as a month; entity resolver may match it as a contact
   - What's unclear: Exact precedence rule when both claim the same token
   - Recommendation: Entity resolution takes precedence. If "June" matches a contact, strip it before chrono parsing. Implement and test.

2. **Qdrant event_time payload index creation**
   - What we know: No index currently exists; Qdrant supports datetime indexes
   - What's unclear: Whether `createPayloadIndex` is idempotent (safe to call on startup)
   - Recommendation: Wrap in try/catch in `onModuleInit`, similar to existing `ensureCollection` pattern. Qdrant REST API returns 400 if index already exists, which is safe to ignore.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `cd apps/api && pnpm test -- --run nlq-parser` |
| Full suite command | `cd apps/api && pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NLQ-01 | "last week" / "in January" / "yesterday" produce correct date ranges | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "temporal"` | No - Wave 0 |
| NLQ-01 | Qdrant filter includes event_time range | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "filter"` | No - Wave 0 |
| NLQ-01 | Temporal fallback when zero results | integration | `cd apps/api && pnpm vitest run src/memory/__tests__/memory.service.test.ts -t "temporal fallback"` | No - Wave 0 |
| NLQ-02 | Entity names in NLQ produce entity-boosted results | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/memory.service.test.ts -t "entity"` | Partially (existing entity tests) |
| NLQ-03 | Intent classification: recall/browse/find | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "intent"` | No - Wave 0 |
| NLQ-03 | Find intent limits to 5 results | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "find"` | No - Wave 0 |
| NLQ-03 | Browse intent boosts recency weight | unit | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "browse"` | No - Wave 0 |
| PERF-01 | Full NLQ parse + search < 500ms | integration | `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts -t "perf"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `cd apps/api && pnpm vitest run src/memory/__tests__/nlq-parser.test.ts`
- **Per wave merge:** `cd apps/api && pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/memory/__tests__/nlq-parser.test.ts` -- covers NLQ-01, NLQ-03, PERF-01
- [ ] Extend `apps/api/src/memory/__tests__/memory.service.test.ts` -- covers temporal fallback, intent-based limits
- [ ] `chrono-node` package install: `cd apps/api && pnpm add chrono-node`

## Sources

### Primary (HIGH confidence)
- [chrono-node GitHub](https://github.com/wanasit/chrono) - API docs, ParsedResult structure, isCertain() method, version 2.9.x
- [chrono-node npm](https://www.npmjs.com/package/chrono-node) - Current version confirmation
- [Qdrant Filtering Docs](https://qdrant.tech/documentation/concepts/filtering/) - Datetime range filter syntax, RFC 3339 format support
- Codebase: `apps/api/src/memory/memory.service.ts` - Existing search pipeline, `resolveEntities()`, `buildQdrantFilter()`, `computeWeights()`, `SearchFilters`, `SearchResponse`
- Codebase: `apps/api/src/memory/qdrant.service.ts` - Qdrant client wrapper, search method
- Codebase: `apps/api/src/memory/embed.processor.ts` - event_time stored as ISO 8601 string in Qdrant payload
- Codebase: `packages/cli/src/commands/search.ts` - CLI search command, displays resolvedEntities
- Codebase: `apps/web/src/components/memory/SearchResultsBanner.tsx` - Frontend search feedback banner

### Secondary (MEDIUM confidence)
- [Qdrant Payload Indexing](https://qdrant.tech/documentation/concepts/indexing/) - Payload index creation for datetime fields

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - chrono-node is well-documented, stable, TypeScript-native, and locked by user decision
- Architecture: HIGH - Integration points are clearly identified in existing codebase; pattern is straightforward pre-processing layer
- Pitfalls: HIGH - Identified from direct codebase analysis (missing Qdrant index, token stripping edge cases, contact/month name collisions)

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, no fast-moving dependencies)
