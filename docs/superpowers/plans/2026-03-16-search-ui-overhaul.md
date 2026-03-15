# Search UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Memory Explorer page with faceted search, conversation mode, enhanced result cards, and keyboard navigation.

**Architecture:** Extend the existing memoryStore with facet/filter/conversation state. Backend adds `factuality_label` to Typesense schema, returns `facet_counts`, and exposes a new `/memories/ask` RAG endpoint. Frontend replaces MemorySearchBar with SearchHeader + FacetSidebar in a 3-column layout.

**Tech Stack:** React 19, Zustand 5, Tailwind 4, NestJS 11, Typesense, SSE

**Spec:** `docs/superpowers/specs/2026-03-16-search-ui-overhaul-design.md`

---

## Chunk 1: Backend — Typesense Schema + Faceted Search

### Task 1: Add `factuality_label` field to Typesense collection

**Files:**

- Modify: `apps/api/src/memory/typesense.service.ts` (schema at ~line 68)
- Create: `apps/api/src/memory/scripts/backfill-factuality-label.ts`

- [ ] **Step 1: Add factuality_label to collection schema**

In `typesense.service.ts`, add to the `fields` array in the collection schema (~line 68):

```typescript
{ name: 'factuality_label', type: 'string', facet: true, optional: true },
```

- [ ] **Step 2: Update upsertDocument to populate factuality_label**

Find the method that upserts documents to Typesense (search for `upsert` or `import`). Add `factuality_label` extraction from the memory's factuality JSON:

```typescript
factuality_label: memory.factuality?.label || 'UNVERIFIED',
```

- [ ] **Step 3: Write backfill script**

Create `apps/api/src/memory/scripts/backfill-factuality-label.ts`:

```typescript
/**
 * One-time script: adds factuality_label field to existing Typesense docs.
 * Run: npx tsx apps/api/src/memory/scripts/backfill-factuality-label.ts
 */
import Typesense from 'typesense';

const client = new Typesense.Client({
  nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
  apiKey: process.env.TYPESENSE_API_KEY || 'botmem-ts-key',
});

async function run() {
  // First, add the field to the schema if not present
  try {
    await client.collections('memories').update({
      fields: [{ name: 'factuality_label', type: 'string', facet: true, optional: true }],
    });
    console.log('Schema updated');
  } catch (e: any) {
    if (e.message?.includes('already exists')) console.log('Field already exists');
    else throw e;
  }

  // Fetch all docs in batches and update factuality_label
  let page = 1;
  const perPage = 250;
  let updated = 0;

  while (true) {
    const results = await client.collections('memories').documents().search({
      q: '*',
      per_page: perPage,
      page,
      filter_by: 'factuality_label:=""', // only missing ones
    });

    if (!results.hits?.length) break;

    for (const hit of results.hits) {
      const doc = hit.document as any;
      // Parse factuality from the stored text field or default
      const label = doc.factuality_label || 'UNVERIFIED';
      try {
        await client.collections('memories').documents(doc.id).update({
          factuality_label: label,
        });
        updated++;
      } catch {
        // skip failures
      }
    }

    console.log(`Updated ${updated} docs (page ${page})`);
    if (results.hits.length < perPage) break;
    page++;
  }

  console.log(`Done. Total updated: ${updated}`);
}

run().catch(console.error);
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/memory/typesense.service.ts apps/api/src/memory/scripts/backfill-factuality-label.ts
git commit -m "feat(search): add factuality_label facet field to Typesense schema"
```

---

### Task 2: Add facet_by to search and return facet_counts

**Files:**

- Modify: `apps/api/src/memory/typesense.service.ts` (~line 114, search method)
- Modify: `apps/api/src/memory/memory.service.ts` (~line 468, search method)
- Modify: `apps/api/src/memory/memory.controller.ts` (~line 322, search endpoint)

- [ ] **Step 1: Add facet_by to Typesense search params**

In `typesense.service.ts`, find the search method. Add `facet_by` to the search parameters object:

```typescript
facet_by: 'connector_type,source_type,factuality_label,people',
```

- [ ] **Step 2: Return facet_counts from TypesenseService**

Update the return type of the search method to include `facetCounts`. Extract `facet_counts` from the Typesense response and return it alongside results:

```typescript
return {
  results: scoredPoints,
  facetCounts: searchResult.facet_counts || [],
};
```

- [ ] **Step 3: Pass facetCounts through MemoryService.search()**

In `memory.service.ts` search method (~line 468), capture the facetCounts from TypesenseService and include in the SearchResult:

Add to SearchResult interface (~line 102):

```typescript
facetCounts?: Array<{
  field_name: string;
  counts: Array<{ value: string; count: number }>;
}>;
```

Pass it through:

```typescript
return {
  results: rankedResults,
  resolvedEntities,
  parsed,
  facetCounts: typesenseResult.facetCounts,
};
```

- [ ] **Step 4: Return facetCounts from controller**

In `memory.controller.ts` search endpoint (~line 322), add `facetCounts` to the response:

```typescript
return {
  items: result.results.map(/* existing mapping */),
  fallback: result.fallback,
  resolvedEntities: result.resolvedEntities,
  parsed: result.parsed,
  facetCounts: result.facetCounts,
};
```

- [ ] **Step 5: Verify with curl**

```bash
curl -s -X POST http://localhost:12412/api/memories/search \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"query":"test","limit":5}' | jq '.facetCounts'
```

Expected: array of facet objects with field_name and counts.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/memory/typesense.service.ts apps/api/src/memory/memory.service.ts apps/api/src/memory/memory.controller.ts
git commit -m "feat(search): return facet_counts from search endpoint"
```

---

### Task 3: Replace loose filters DTO with typed SearchFiltersDto

**Files:**

- Create: `apps/api/src/memory/dto/search-filters.dto.ts`
- Modify: `apps/api/src/memory/dto/search-memories.dto.ts`
- Modify: `apps/api/src/memory/memory.service.ts` (~line 77, SearchFilters interface + filter_by builder)
- Modify: `apps/api/src/memory/memory.controller.ts` (search endpoint)

- [ ] **Step 1: Create SearchFiltersDto**

Create `apps/api/src/memory/dto/search-filters.dto.ts`:

```typescript
import { IsOptional, IsArray, IsString, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TimeRangeDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class SearchFiltersDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  connectorTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factualityLabels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  personNames?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TimeRangeDto)
  timeRange?: TimeRangeDto;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
```

- [ ] **Step 2: Update SearchMemoriesDto to use new filters type**

In `search-memories.dto.ts`, change `filters` from `Record<string, string>` to `SearchFiltersDto`:

```typescript
import { SearchFiltersDto } from './search-filters.dto';

// Change:
// @IsOptional() filters?: Record<string, string>;
// To:
@IsOptional()
@ValidateNested()
@Type(() => SearchFiltersDto)
filters?: SearchFiltersDto;
```

- [ ] **Step 3: Update MemoryService.search() to handle typed filters**

In `memory.service.ts`, update the SearchFilters interface and the filter_by string builder to handle arrays:

```typescript
// Build Typesense filter_by from typed filters
const filterParts: string[] = [];

if (filters.connectorTypes?.length) {
  filterParts.push(`connector_type:[${filters.connectorTypes.join(',')}]`);
}
if (filters.sourceTypes?.length) {
  filterParts.push(`source_type:[${filters.sourceTypes.join(',')}]`);
}
if (filters.factualityLabels?.length) {
  filterParts.push(`factuality_label:[${filters.factualityLabels.join(',')}]`);
}
if (filters.personNames?.length) {
  filterParts.push(`people:[${filters.personNames.join(',')}]`);
}
if (filters.timeRange?.from) {
  filterParts.push(`event_time:>=${filters.timeRange.from}`);
}
if (filters.timeRange?.to) {
  filterParts.push(`event_time:<=${filters.timeRange.to}`);
}
// Keep existing userId/accountIds/memoryBankId filter logic unchanged
```

- [ ] **Step 4: Maintain backwards compatibility**

Keep the existing `sourceType?: string` filter working by mapping it into the new `sourceTypes` array if present:

```typescript
// In controller, before passing to service:
if (typeof dto.filters?.sourceType === 'string') {
  dto.filters.sourceTypes = [dto.filters.sourceType];
}
```

- [ ] **Step 5: Run existing tests**

```bash
cd apps/api && pnpm test -- --run
```

Expected: all existing tests pass (backwards-compatible).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/memory/dto/ apps/api/src/memory/memory.service.ts apps/api/src/memory/memory.controller.ts
git commit -m "feat(search): typed SearchFiltersDto with array filters and time range"
```

---

### Task 4: Add POST /memories/ask endpoint

**Files:**

- Create: `apps/api/src/memory/dto/ask-memories.dto.ts`
- Modify: `apps/api/src/memory/memory.controller.ts`
- Modify: `apps/api/src/memory/memory.service.ts`

- [ ] **Step 1: Create AskMemoriesDto**

Create `apps/api/src/memory/dto/ask-memories.dto.ts`:

```typescript
import { IsString, IsOptional, MinLength } from 'class-validator';

export class AskMemoriesDto {
  @IsString()
  @MinLength(1)
  query: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  memoryBankId?: string;
}
```

- [ ] **Step 2: Add ask() method to MemoryService**

In `memory.service.ts`, add a new method that wraps conversationSearch:

```typescript
async ask(
  query: string,
  conversationId?: string,
  userId?: string,
  memoryBankId?: string,
): Promise<{
  answer: string;
  conversationId: string;
  citations: any[];
}> {
  // Generate embedding for the query
  const vector = await this.embedService.embed(query);

  // Get conversation model ID from config
  const conversationModelId = this.configService.get('TYPESENSE_CONV_MODEL_ID') || 'botmem-chat';

  // Build filter for user isolation
  const accountIds = userId ? await this.getAccountIds(userId) : undefined;
  const filter = this.buildFilterBy({ userId, accountIds, memoryBankId });

  const result = await this.typesenseService.conversationSearch(
    query,
    vector,
    20,
    conversationModelId,
    conversationId || undefined,
    filter,
  );

  return {
    answer: result.conversation?.answer || 'No relevant memories found for this question.',
    conversationId: result.conversation?.conversationId || '',
    citations: result.results.map((r) => this.mapToApiItem(r)),
  };
}
```

- [ ] **Step 3: Add controller endpoint**

In `memory.controller.ts`, add the ask endpoint:

```typescript
@Post('ask')
async ask(@Body() dto: AskMemoriesDto, @Req() req: any) {
  const userId = req.user?.id;
  try {
    const result = await this.memoryService.ask(
      dto.query,
      dto.conversationId,
      userId,
      dto.memoryBankId,
    );
    return result;
  } catch (error: any) {
    if (error.message?.includes('conversation model')) {
      return { error: 'Conversation mode not available', code: 'NO_CONV_MODEL' };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Verify with curl**

```bash
curl -s -X POST http://localhost:12412/api/memories/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"query":"What emails did I get last week?"}' | jq
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/memory/dto/ask-memories.dto.ts apps/api/src/memory/memory.controller.ts apps/api/src/memory/memory.service.ts
git commit -m "feat(search): add POST /memories/ask RAG conversation endpoint"
```

---

## Chunk 2: Frontend — Store + API Client + Hook Updates

### Task 5: Update API client with facetCounts and ask method

**Files:**

- Modify: `apps/web/src/lib/api.ts` (~line 323, searchMemories method)

- [ ] **Step 1: Add FacetCount type and update ApiSearchResponse**

```typescript
export interface FacetCount {
  field_name: string;
  counts: Array<{ value: string; count: number }>;
}

// Add to ApiSearchResponse:
export interface ApiSearchResponse {
  items: ApiMemoryItem[];
  fallback: boolean;
  resolvedEntities?: {
    /* existing */
  };
  parsed?: {
    /* existing */
  };
  facetCounts?: FacetCount[];
}
```

- [ ] **Step 2: Add searchFilters param to searchMemories**

Update `searchMemories` to accept typed filters:

```typescript
async searchMemories(
  query: string,
  filters?: {
    connectorTypes?: string[];
    sourceTypes?: string[];
    factualityLabels?: string[];
    personNames?: string[];
    timeRange?: { from?: string; to?: string };
    pinned?: boolean;
  },
  limit?: number,
  memoryBankId?: string,
): Promise<ApiSearchResponse> {
  const res = await this.post('/memories/search', {
    query,
    filters,
    limit,
    memoryBankId,
  });
  return res.json();
}
```

- [ ] **Step 3: Add askMemories method**

```typescript
async askMemories(
  query: string,
  conversationId?: string,
  memoryBankId?: string,
): Promise<{ answer: string; conversationId: string; citations: ApiMemoryItem[] }> {
  const res = await this.post('/memories/ask', {
    query,
    conversationId,
    memoryBankId,
  });
  return res.json();
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): add facetCounts type and askMemories API method"
```

---

### Task 6: Extend memoryStore with facets, activeFilters, conversation

**Files:**

- Modify: `apps/web/src/store/memoryStore.ts`

- [ ] **Step 1: Add types at top of file**

```typescript
export interface FacetValue {
  value: string;
  count: number;
}

export interface ActiveFilters {
  connectorTypes: string[];
  sourceTypes: string[];
  factualityLabels: string[];
  personNames: string[];
  timeRange: { from: string | null; to: string | null };
  pinned: boolean | null;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: any[];
  timestamp: number;
}

const EMPTY_FILTERS: ActiveFilters = {
  connectorTypes: [],
  sourceTypes: [],
  factualityLabels: [],
  personNames: [],
  timeRange: { from: null, to: null },
  pinned: null,
};
```

- [ ] **Step 2: Add new state fields to the store**

Add to the store state:

```typescript
// Mode
mode: 'search' | 'ask';
setMode: (m: 'search' | 'ask') => void;

// Facets
facets: {
  connectorType: FacetValue[];
  sourceType: FacetValue[];
  factuality: FacetValue[];
  people: FacetValue[];
};

// Active filters
activeFilters: ActiveFilters;
toggleFilter: (key: keyof ActiveFilters, value: string) => void;
setTimeRange: (from: string | null, to: string | null) => void;
clearAllFilters: () => void;

// Presets
activePreset: string | null;
applyPreset: (presetId: string) => void;

// Conversation
conversation: {
  id: string | null;
  messages: ConversationMessage[];
  loading: boolean;
};
sendMessage: (query: string) => Promise<void>;
clearConversation: () => void;
```

- [ ] **Step 3: Implement store actions**

```typescript
// Initial values
mode: 'search',
facets: { connectorType: [], sourceType: [], factuality: [], people: [] },
activeFilters: { ...EMPTY_FILTERS },
activePreset: null,
conversation: { id: null, messages: [], loading: false },

setMode: (m) => set({ mode: m }),

toggleFilter: (key, value) => set((s) => {
  const current = s.activeFilters[key];
  if (!Array.isArray(current)) return s;
  const next = current.includes(value)
    ? current.filter((v: string) => v !== value)
    : [...current, value];
  return {
    activeFilters: { ...s.activeFilters, [key]: next },
    activePreset: null, // clear preset when manually filtering
  };
}),

setTimeRange: (from, to) => set((s) => ({
  activeFilters: { ...s.activeFilters, timeRange: { from, to } },
  activePreset: null,
})),

clearAllFilters: () => set({ activeFilters: { ...EMPTY_FILTERS }, activePreset: null }),

applyPreset: (presetId) => set((s) => {
  if (s.activePreset === presetId) {
    return { activeFilters: { ...EMPTY_FILTERS }, activePreset: null };
  }
  const presets: Record<string, Partial<ActiveFilters>> = {
    recent_emails: { sourceTypes: ['email'] },
    recent_photos: { sourceTypes: ['photo'] },
    pinned: { pinned: true },
    facts_only: { factualityLabels: ['FACT'] },
    this_week: {
      timeRange: {
        from: new Date(Date.now() - 7 * 86400000).toISOString(),
        to: new Date().toISOString(),
      },
    },
  };
  return {
    activeFilters: { ...EMPTY_FILTERS, ...presets[presetId] },
    activePreset: presetId,
  };
}),

sendMessage: async (query) => {
  const s = get();
  set((prev) => ({
    conversation: {
      ...prev.conversation,
      loading: true,
      messages: [
        ...prev.conversation.messages,
        { role: 'user' as const, content: query, timestamp: Date.now() },
      ],
    },
  }));
  try {
    const bankId = undefined; // will integrate memoryBankStore later
    const result = await api.askMemories(query, s.conversation.id || undefined, bankId);
    set((prev) => ({
      conversation: {
        id: result.conversationId,
        loading: false,
        messages: [
          ...prev.conversation.messages,
          {
            role: 'assistant' as const,
            content: result.answer,
            citations: result.citations,
            timestamp: Date.now(),
          },
        ],
      },
    }));
  } catch {
    set((prev) => ({
      conversation: { ...prev.conversation, loading: false },
    }));
  }
},

clearConversation: () => set({
  conversation: { id: null, messages: [], loading: false },
}),
```

- [ ] **Step 4: Update setSearchResults to populate facets**

Find the existing `setSearchResults` action and add facet parsing:

```typescript
// After setting items, also set facets from response.facetCounts
const facetMap: Record<string, FacetValue[]> = {};
for (const fc of response.facetCounts || []) {
  facetMap[fc.field_name] = fc.counts.map((c) => ({ value: c.value, count: c.count }));
}
set({
  facets: {
    connectorType: facetMap['connector_type'] || [],
    sourceType: facetMap['source_type'] || [],
    factuality: facetMap['factuality_label'] || [],
    people: facetMap['people'] || [],
  },
});
```

- [ ] **Step 5: Replace old filters with activeFilters in searchMemories**

Update the store's `searchMemories` action to pass `activeFilters` to the API:

```typescript
// Change from:
// const res = await api.searchMemories(query, { sourceType: filters.source }, limit, bankId);
// To:
const res = await api.searchMemories(query, get().activeFilters, limit, bankId);
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/memoryStore.ts
git commit -m "feat(web): extend memoryStore with facets, activeFilters, conversation"
```

---

### Task 7: Update useSearch and useMemories hooks

**Files:**

- Modify: `apps/web/src/hooks/useSearch.ts`
- Modify: `apps/web/src/hooks/useMemories.ts`

- [ ] **Step 1: Update useSearch to pass activeFilters**

In `useSearch.ts`, read `activeFilters` from memoryStore and pass to the API call:

```typescript
const activeFilters = useMemoryStore((s) => s.activeFilters);

// In the search effect, pass filters:
const res = await api.searchMemories(debouncedTerm, activeFilters, opts.limit, opts.memoryBankId);
```

- [ ] **Step 2: Update useMemories to expose new store fields**

In `useMemories.ts`, add selectors for the new fields:

```typescript
const mode = useMemoryStore((s) => s.mode);
const setMode = useMemoryStore((s) => s.setMode);
const facets = useMemoryStore((s) => s.facets);
const activeFilters = useMemoryStore((s) => s.activeFilters);
const toggleFilter = useMemoryStore((s) => s.toggleFilter);
const setTimeRange = useMemoryStore((s) => s.setTimeRange);
const clearAllFilters = useMemoryStore((s) => s.clearAllFilters);
const activePreset = useMemoryStore((s) => s.activePreset);
const applyPreset = useMemoryStore((s) => s.applyPreset);
const conversation = useMemoryStore((s) => s.conversation);
const sendMessage = useMemoryStore((s) => s.sendMessage);
const clearConversation = useMemoryStore((s) => s.clearConversation);

// Return all of these alongside existing return values
```

- [ ] **Step 3: Remove old source filter from useMemories**

Remove the old `useMemo` that filters by `filters.source` — filtering is now done server-side via activeFilters.

- [ ] **Step 4: Run frontend dev to verify no crashes**

```bash
cd apps/web && pnpm dev
```

Check browser console for errors. Search should still work.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useSearch.ts apps/web/src/hooks/useMemories.ts
git commit -m "feat(web): update hooks to use activeFilters and expose facet state"
```

---

## Chunk 3: Frontend — New UI Components

### Task 8: Create FacetCheckbox and FacetGroup components

**Files:**

- Create: `apps/web/src/components/memory/FacetCheckbox.tsx`
- Create: `apps/web/src/components/memory/FacetGroup.tsx`

- [ ] **Step 1: Create FacetCheckbox**

```tsx
import { cn } from '@/lib/utils';

interface FacetCheckboxProps {
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
  color?: string; // optional accent color class
  disabled?: boolean;
}

export function FacetCheckbox({
  label,
  count,
  checked,
  onChange,
  color,
  disabled,
}: FacetCheckboxProps) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 py-1 cursor-pointer group',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'size-4 border-2 border-nb-border flex items-center justify-center shrink-0 transition-colors',
          checked && (color || 'bg-nb-lime border-nb-lime'),
        )}
        onClick={(e) => {
          e.preventDefault();
          if (!disabled) onChange();
        }}
      >
        {checked && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="black"
            strokeWidth="2"
          >
            <path d="M2 5l2 2 4-4" />
          </svg>
        )}
      </span>
      <span className="font-mono text-xs text-nb-text truncate flex-1">{label}</span>
      <span className="font-mono text-[10px] text-nb-muted tabular-nums">{count}</span>
    </label>
  );
}
```

- [ ] **Step 2: Create FacetGroup**

```tsx
import { useState } from 'react';
import { cn } from '@/lib/utils';

interface FacetGroupProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function FacetGroup({ title, children, defaultOpen = true }: FacetGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-nb-border/30 pb-3 mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full cursor-pointer group"
      >
        <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted">
          {title}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn('text-nb-muted transition-transform duration-200', open && 'rotate-180')}
        >
          <path d="M3 5l3 3 3-3" />
        </svg>
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          open ? 'max-h-96 mt-2' : 'max-h-0',
        )}
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/memory/FacetCheckbox.tsx apps/web/src/components/memory/FacetGroup.tsx
git commit -m "feat(web): add FacetCheckbox and FacetGroup components"
```

---

### Task 9: Create TimeRangeFacet and PeopleFacet

**Files:**

- Create: `apps/web/src/components/memory/TimeRangeFacet.tsx`
- Create: `apps/web/src/components/memory/PeopleFacet.tsx`

- [ ] **Step 1: Create TimeRangeFacet**

```tsx
interface TimeRangeFacetProps {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}

export function TimeRangeFacet({ from, to, onChange }: TimeRangeFacetProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="font-mono text-[10px] text-nb-muted uppercase">From</label>
      <input
        type="date"
        value={from?.split('T')[0] || ''}
        onChange={(e) =>
          onChange(e.target.value ? new Date(e.target.value).toISOString() : null, to)
        }
        className="border-2 border-nb-border bg-transparent px-2 py-1 font-mono text-xs text-nb-text focus:border-nb-lime outline-none"
      />
      <label className="font-mono text-[10px] text-nb-muted uppercase">To</label>
      <input
        type="date"
        value={to?.split('T')[0] || ''}
        onChange={(e) =>
          onChange(from, e.target.value ? new Date(e.target.value).toISOString() : null)
        }
        className="border-2 border-nb-border bg-transparent px-2 py-1 font-mono text-xs text-nb-text focus:border-nb-lime outline-none"
      />
    </div>
  );
}
```

- [ ] **Step 2: Create PeopleFacet**

```tsx
import { FacetCheckbox } from './FacetCheckbox';
import type { FacetValue } from '../../store/memoryStore';

interface PeopleFacetProps {
  people: FacetValue[];
  selected: string[];
  onToggle: (name: string) => void;
}

export function PeopleFacet({ people, selected, onToggle }: PeopleFacetProps) {
  return (
    <div className="flex flex-col">
      {people.slice(0, 10).map((p) => (
        <div key={p.value} className="flex items-center gap-1.5">
          <span
            className="size-4 shrink-0 border border-nb-border/50 bg-nb-surface-muted flex items-center justify-center font-mono text-[8px] text-nb-muted uppercase"
            title={p.value}
          >
            {p.value.charAt(0)}
          </span>
          <FacetCheckbox
            label={p.value}
            count={p.count}
            checked={selected.includes(p.value)}
            onChange={() => onToggle(p.value)}
          />
        </div>
      ))}
      {people.length > 10 && (
        <span className="font-mono text-[10px] text-nb-muted mt-1">+{people.length - 10} more</span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/memory/TimeRangeFacet.tsx apps/web/src/components/memory/PeopleFacet.tsx
git commit -m "feat(web): add TimeRangeFacet and PeopleFacet components"
```

---

### Task 10: Create FacetSidebar

**Files:**

- Create: `apps/web/src/components/memory/FacetSidebar.tsx`

- [ ] **Step 1: Create FacetSidebar**

```tsx
import { FacetGroup } from './FacetGroup';
import { FacetCheckbox } from './FacetCheckbox';
import { TimeRangeFacet } from './TimeRangeFacet';
import { PeopleFacet } from './PeopleFacet';
import type { FacetValue, ActiveFilters } from '../../store/memoryStore';

const CONNECTOR_COLORS: Record<string, string> = {
  gmail: 'bg-nb-red',
  whatsapp: 'bg-nb-green',
  imessage: 'bg-nb-blue',
  slack: 'bg-nb-purple',
  photos: 'bg-nb-orange',
};

interface FacetSidebarProps {
  facets: {
    connectorType: FacetValue[];
    sourceType: FacetValue[];
    factuality: FacetValue[];
    people: FacetValue[];
  };
  activeFilters: ActiveFilters;
  onToggleFilter: (key: keyof ActiveFilters, value: string) => void;
  onTimeRangeChange: (from: string | null, to: string | null) => void;
}

export function FacetSidebar({
  facets,
  activeFilters,
  onToggleFilter,
  onTimeRangeChange,
}: FacetSidebarProps) {
  return (
    <div className="p-4 overflow-y-auto h-full">
      <FacetGroup title="Connector">
        {facets.connectorType.map((f) => (
          <FacetCheckbox
            key={f.value}
            label={f.value}
            count={f.count}
            checked={activeFilters.connectorTypes.includes(f.value)}
            onChange={() => onToggleFilter('connectorTypes', f.value)}
            color={CONNECTOR_COLORS[f.value]}
            disabled={f.count === 0}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Source Type">
        {facets.sourceType.map((f) => (
          <FacetCheckbox
            key={f.value}
            label={f.value}
            count={f.count}
            checked={activeFilters.sourceTypes.includes(f.value)}
            onChange={() => onToggleFilter('sourceTypes', f.value)}
            disabled={f.count === 0}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Factuality">
        {facets.factuality.map((f) => (
          <FacetCheckbox
            key={f.value}
            label={f.value}
            count={f.count}
            checked={activeFilters.factualityLabels.includes(f.value)}
            onChange={() => onToggleFilter('factualityLabels', f.value)}
            disabled={f.count === 0}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="People">
        <PeopleFacet
          people={facets.people}
          selected={activeFilters.personNames}
          onToggle={(name) => onToggleFilter('personNames', name)}
        />
      </FacetGroup>

      <FacetGroup title="Time Range">
        <TimeRangeFacet
          from={activeFilters.timeRange.from}
          to={activeFilters.timeRange.to}
          onChange={onTimeRangeChange}
        />
      </FacetGroup>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/memory/FacetSidebar.tsx
git commit -m "feat(web): add FacetSidebar component"
```

---

### Task 11: Create SearchHeader, SearchPresets, and ActiveFilters

**Files:**

- Create: `apps/web/src/components/memory/SearchHeader.tsx`
- Create: `apps/web/src/components/memory/SearchPresets.tsx`
- Create: `apps/web/src/components/memory/ActiveFilters.tsx`

- [ ] **Step 1: Create SearchPresets**

```tsx
import { cn } from '@/lib/utils';

const PRESETS = [
  { id: 'recent_emails', label: 'EMAILS' },
  { id: 'recent_photos', label: 'PHOTOS' },
  { id: 'pinned', label: 'PINNED' },
  { id: 'facts_only', label: 'FACTS' },
  { id: 'this_week', label: 'THIS WEEK' },
];

interface SearchPresetsProps {
  activePreset: string | null;
  onApply: (presetId: string) => void;
}

export function SearchPresets({ activePreset, onApply }: SearchPresetsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto py-1 scrollbar-none">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          onClick={() => onApply(p.id)}
          className={cn(
            'shrink-0 border-2 border-nb-border px-3 py-1 font-mono text-xs uppercase cursor-pointer transition-colors',
            activePreset === p.id
              ? 'bg-nb-lime/20 border-nb-lime text-nb-lime'
              : 'text-nb-muted hover:text-nb-text hover:border-nb-text',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create ActiveFilters**

```tsx
interface ActiveFiltersProps {
  connectorTypes: string[];
  sourceTypes: string[];
  factualityLabels: string[];
  personNames: string[];
  timeRange: { from: string | null; to: string | null };
  onRemove: (key: string, value: string) => void;
  onClearAll: () => void;
}

export function ActiveFilters({
  connectorTypes,
  sourceTypes,
  factualityLabels,
  personNames,
  timeRange,
  onRemove,
  onClearAll,
}: ActiveFiltersProps) {
  const pills: Array<{ key: string; value: string; label: string }> = [
    ...connectorTypes.map((v) => ({ key: 'connectorTypes', value: v, label: v })),
    ...sourceTypes.map((v) => ({ key: 'sourceTypes', value: v, label: v })),
    ...factualityLabels.map((v) => ({ key: 'factualityLabels', value: v, label: v })),
    ...personNames.map((v) => ({ key: 'personNames', value: v, label: v })),
  ];

  if (timeRange.from)
    pills.push({ key: 'timeRange', value: 'from', label: `From ${timeRange.from.split('T')[0]}` });
  if (timeRange.to)
    pills.push({ key: 'timeRange', value: 'to', label: `To ${timeRange.to.split('T')[0]}` });

  if (pills.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pills.map((p) => (
        <span
          key={`${p.key}-${p.value}`}
          className="inline-flex items-center gap-1 bg-nb-surface border-2 border-nb-border px-2 py-1 font-mono text-xs"
        >
          {p.label}
          <button
            onClick={() => onRemove(p.key, p.value)}
            className="text-nb-muted hover:text-nb-red cursor-pointer ml-1"
          >
            x
          </button>
        </span>
      ))}
      {pills.length > 1 && (
        <button
          onClick={onClearAll}
          className="font-mono text-xs text-nb-muted hover:text-nb-lime underline cursor-pointer"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create SearchHeader**

```tsx
import { cn } from '@/lib/utils';
import { SearchPresets } from './SearchPresets';

interface SearchHeaderProps {
  query: string;
  onQueryChange: (q: string) => void;
  mode: 'search' | 'ask';
  onModeChange: (m: 'search' | 'ask') => void;
  activePreset: string | null;
  onApplyPreset: (id: string) => void;
  resultCount: number;
  loading: boolean;
  pending: boolean;
  onToggleFilters?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function SearchHeader({
  query,
  onQueryChange,
  mode,
  onModeChange,
  activePreset,
  onApplyPreset,
  resultCount,
  loading,
  pending,
  onToggleFilters,
  inputRef,
}: SearchHeaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {/* Mobile filter toggle */}
        <button
          onClick={onToggleFilters}
          className="md:hidden border-2 border-nb-border size-10 flex items-center justify-center cursor-pointer hover:bg-nb-lime hover:text-black transition-colors text-nb-muted"
          title="Filters"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M2 4h12M4 8h8M6 12h4" />
          </svg>
        </button>

        {/* Mode toggle */}
        <div className="flex border-2 border-nb-border shrink-0">
          <button
            onClick={() => onModeChange('search')}
            className={cn(
              'px-3 py-2 font-display text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors',
              mode === 'search'
                ? 'bg-nb-lime text-black'
                : 'bg-transparent text-nb-muted hover:text-nb-text',
            )}
          >
            Search
          </button>
          <button
            onClick={() => onModeChange('ask')}
            className={cn(
              'px-3 py-2 font-display text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors border-l-2 border-nb-border',
              mode === 'ask'
                ? 'bg-nb-lime text-black'
                : 'bg-transparent text-nb-muted hover:text-nb-text',
            )}
          >
            Ask
          </button>
        </div>

        {/* Search input */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={mode === 'search' ? 'Search memories...' : 'Ask about your memories...'}
            className="w-full border-2 border-nb-border bg-transparent px-4 py-2 font-mono text-sm text-nb-text placeholder:text-nb-muted/50 focus:border-nb-lime outline-none"
          />
          {(loading || pending) && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="size-4 border-2 border-nb-lime border-t-transparent animate-spin" />
            </div>
          )}
        </div>

        {/* Result count */}
        <span className="font-mono text-xs text-nb-muted shrink-0 tabular-nums hidden sm:block">
          {resultCount}
        </span>
      </div>

      <SearchPresets activePreset={activePreset} onApply={onApplyPreset} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/memory/SearchHeader.tsx apps/web/src/components/memory/SearchPresets.tsx apps/web/src/components/memory/ActiveFilters.tsx
git commit -m "feat(web): add SearchHeader, SearchPresets, and ActiveFilters components"
```

---

### Task 12: Create MobileFilterDrawer

**Files:**

- Create: `apps/web/src/components/memory/MobileFilterDrawer.tsx`

- [ ] **Step 1: Create MobileFilterDrawer**

```tsx
import { cn } from '@/lib/utils';
import { FacetSidebar } from './FacetSidebar';
import type { FacetValue, ActiveFilters } from '../../store/memoryStore';

interface MobileFilterDrawerProps {
  open: boolean;
  onClose: () => void;
  facets: {
    connectorType: FacetValue[];
    sourceType: FacetValue[];
    factuality: FacetValue[];
    people: FacetValue[];
  };
  activeFilters: ActiveFilters;
  onToggleFilter: (key: keyof ActiveFilters, value: string) => void;
  onTimeRangeChange: (from: string | null, to: string | null) => void;
}

export function MobileFilterDrawer({
  open,
  onClose,
  facets,
  activeFilters,
  onToggleFilter,
  onTimeRangeChange,
}: MobileFilterDrawerProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 bg-nb-bg border-r-4 border-nb-border transition-transform duration-200 md:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between p-4 border-b-2 border-nb-border">
          <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
            Filters
          </span>
          <button
            onClick={onClose}
            className="border-2 border-nb-border size-8 flex items-center justify-center cursor-pointer hover:bg-nb-lime hover:text-black transition-colors text-nb-muted"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
        <FacetSidebar
          facets={facets}
          activeFilters={activeFilters}
          onToggleFilter={onToggleFilter}
          onTimeRangeChange={onTimeRangeChange}
        />
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/memory/MobileFilterDrawer.tsx
git commit -m "feat(web): add MobileFilterDrawer component"
```

---

### Task 13: Create ConversationPanel, ConversationMessage, CitationCard

**Files:**

- Create: `apps/web/src/components/memory/ConversationPanel.tsx`
- Create: `apps/web/src/components/memory/ConversationMessage.tsx`
- Create: `apps/web/src/components/memory/CitationCard.tsx`

- [ ] **Step 1: Create CitationCard**

```tsx
import type { Memory } from '@botmem/shared';

interface CitationCardProps {
  memory: Memory;
  index: number;
  onClick?: () => void;
}

export function CitationCard({ memory, index, onClick }: CitationCardProps) {
  return (
    <button
      onClick={onClick}
      className="border-2 border-nb-border/50 bg-nb-surface/50 p-2 text-left cursor-pointer hover:border-nb-lime transition-colors w-full"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-[10px] text-nb-lime">[{index + 1}]</span>
        <span className="font-mono text-[10px] text-nb-muted uppercase">
          {memory.sourceConnector}
        </span>
        <span className="font-mono text-[10px] text-nb-muted">
          {memory.time ? new Date(memory.time).toLocaleDateString() : ''}
        </span>
      </div>
      <p className="font-mono text-xs text-nb-text line-clamp-2">{memory.text}</p>
    </button>
  );
}
```

- [ ] **Step 2: Create ConversationMessage**

```tsx
import { cn } from '@/lib/utils';
import { CitationCard } from './CitationCard';
import type { ConversationMessage as ConvMsg } from '../../store/memoryStore';

interface ConversationMessageProps {
  message: ConvMsg;
  onCitationClick?: (memoryId: string) => void;
}

export function ConversationMessage({ message, onCitationClick }: ConversationMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('mb-6', isUser && 'text-right')}>
      <div
        className={cn(
          'inline-block max-w-[85%] text-left',
          isUser ? 'font-display text-nb-lime' : 'font-body text-nb-text',
        )}
      >
        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
      </div>

      {/* Citations */}
      {message.citations && message.citations.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 max-w-[85%]">
          <span className="font-mono text-[10px] text-nb-muted uppercase">Sources</span>
          {message.citations.slice(0, 5).map((c: any, i: number) => (
            <CitationCard key={c.id} memory={c} index={i} onClick={() => onCitationClick?.(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create ConversationPanel**

```tsx
import { useRef, useEffect, useState } from 'react';
import { ConversationMessage } from './ConversationMessage';
import type { ConversationMessage as ConvMsg } from '../../store/memoryStore';

interface ConversationPanelProps {
  messages: ConvMsg[];
  loading: boolean;
  onSendMessage: (query: string) => void;
  onCitationClick?: (memoryId: string) => void;
}

export function ConversationPanel({
  messages,
  loading,
  onSendMessage,
  onCitationClick,
}: ConversationPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    onSendMessage(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <span className="font-display text-2xl text-nb-muted">?</span>
            <p className="font-mono text-sm text-nb-muted">Ask anything about your memories</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ConversationMessage key={i} message={msg} onCitationClick={onCitationClick} />
        ))}
        {loading && (
          <div className="flex items-center gap-1 mb-4">
            <span className="size-2 bg-nb-lime animate-pulse" style={{ animationDelay: '0ms' }} />
            <span className="size-2 bg-nb-lime animate-pulse" style={{ animationDelay: '150ms' }} />
            <span className="size-2 bg-nb-lime animate-pulse" style={{ animationDelay: '300ms' }} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t-2 border-nb-border p-3">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a follow-up..."
          disabled={loading}
          className="w-full border-2 border-nb-border bg-transparent px-4 py-2 font-mono text-sm text-nb-text placeholder:text-nb-muted/50 focus:border-nb-lime outline-none disabled:opacity-50"
        />
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/memory/ConversationPanel.tsx apps/web/src/components/memory/ConversationMessage.tsx apps/web/src/components/memory/CitationCard.tsx
git commit -m "feat(web): add ConversationPanel, ConversationMessage, CitationCard"
```

---

## Chunk 4: Frontend — Enhanced Card + Page Rewrite + Keyboard

### Task 14: Enhance MemoryCard with entities, people, factuality

**Files:**

- Modify: `apps/web/src/components/memory/MemoryCard.tsx`

- [ ] **Step 1: Add entity tags row**

After the text excerpt `<p>` element, add:

```tsx
{
  /* Entity tags */
}
{
  memory.entities && memory.entities.length > 0 && (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {memory.entities.slice(0, 5).map((e, i) => {
        const colorMap: Record<string, string> = {
          PERSON: 'text-nb-pink border-nb-pink/30',
          PLACE: 'text-nb-blue border-nb-blue/30',
          ORG: 'text-nb-purple border-nb-purple/30',
          DATE: 'text-nb-yellow border-nb-yellow/30',
        };
        const cls = colorMap[e.type] || 'text-nb-gray border-nb-gray/30';
        return (
          <span key={i} className={`border px-1.5 py-0.5 font-mono text-[10px] ${cls}`}>
            {e.value}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add people row**

After entity tags:

```tsx
{
  /* People */
}
{
  memory.people && memory.people.length > 0 && (
    <div className="flex items-center gap-1 mt-1.5">
      {memory.people.slice(0, 3).map((p, i) => (
        <span
          key={i}
          className="size-4 border border-nb-border/50 bg-nb-surface-muted flex items-center justify-center font-mono text-[7px] text-nb-muted uppercase"
          title={p.displayName}
        >
          {p.displayName?.charAt(0) || '?'}
        </span>
      ))}
      {memory.people.length > 3 && (
        <span className="font-mono text-[10px] text-nb-muted">+{memory.people.length - 3}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add factuality dot badge**

In the top-right area of the card (near the pin button):

```tsx
{
  /* Factuality indicator */
}
{
  memory.factuality?.label && (
    <span
      className={cn(
        'size-2.5',
        memory.factuality.label === 'FACT' && 'bg-nb-green',
        memory.factuality.label === 'UNVERIFIED' && 'bg-nb-yellow',
        memory.factuality.label === 'FICTION' && 'bg-nb-red',
      )}
      title={memory.factuality.label}
    />
  );
}
```

- [ ] **Step 4: Replace score bar with numeric score**

Replace the existing score bar div with:

```tsx
<span className="font-mono text-[10px] text-nb-muted tabular-nums">
  {(memory.weights?.final ?? 0).toFixed(2)}
</span>
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/memory/MemoryCard.tsx
git commit -m "feat(web): enhance MemoryCard with entities, people, factuality badge"
```

---

### Task 15: Create useSearchKeyboard hook

**Files:**

- Create: `apps/web/src/hooks/useSearchKeyboard.ts`

- [ ] **Step 1: Create the hook**

```tsx
import { useEffect, useCallback } from 'react';

interface UseSearchKeyboardOptions {
  inputRef: React.RefObject<HTMLInputElement | null>;
  resultsRef: React.RefObject<HTMLDivElement | null>;
  resultCount: number;
  selectedIndex: number;
  onSelectIndex: (i: number) => void;
  onOpenSelected: () => void;
  onClose: () => void;
  onToggleFilters: () => void;
  onToggleMode: () => void;
}

export function useSearchKeyboard({
  inputRef,
  resultsRef,
  resultCount,
  selectedIndex,
  onSelectIndex,
  onOpenSelected,
  onClose,
  onToggleFilters,
  onToggleMode,
}: UseSearchKeyboardOptions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // / always focuses search
      if (e.key === '/' && !isInputFocused()) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }

      // Esc: close detail / blur input / close filters
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      // j/k only when results area has focus
      const inResults =
        resultsRef.current?.contains(document.activeElement) ||
        document.activeElement === resultsRef.current;

      if (inResults) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          onSelectIndex(Math.min(selectedIndex + 1, resultCount - 1));
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          onSelectIndex(Math.max(selectedIndex - 1, 0));
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpenSelected();
        }
      }

      // Tab in Ask mode: toggle focus between search input and conversation follow-up input
      if (e.key === 'Tab' && document.querySelector('[data-conversation-input]')) {
        const convInput = document.querySelector('[data-conversation-input]') as HTMLInputElement;
        if (document.activeElement === inputRef.current) {
          e.preventDefault();
          convInput?.focus();
        } else if (document.activeElement === convInput) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }

      // Ctrl+Shift shortcuts
      if (e.ctrlKey && e.shiftKey) {
        if (e.key === 'F') {
          e.preventDefault();
          onToggleFilters();
        }
        if (e.key === 'A') {
          e.preventDefault();
          onToggleMode();
        }
      }
    },
    [
      inputRef,
      resultsRef,
      resultCount,
      selectedIndex,
      onSelectIndex,
      onOpenSelected,
      onClose,
      onToggleFilters,
      onToggleMode,
    ],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

function isInputFocused() {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/useSearchKeyboard.ts
git commit -m "feat(web): add useSearchKeyboard hook for keyboard navigation"
```

---

### Task 16: Rewrite MemoryExplorerPage with 3-column layout

**Files:**

- Modify: `apps/web/src/pages/MemoryExplorerPage.tsx`

This is the big integration task. The page wires everything together.

- [ ] **Step 1: Replace the full page component**

Rewrite `MemoryExplorerPage.tsx` with the new 3-column layout:

```tsx
import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { Memory } from '@botmem/shared';
import { PageContainer } from '../components/layout/PageContainer';
import { SearchHeader } from '../components/memory/SearchHeader';
import { FacetSidebar } from '../components/memory/FacetSidebar';
import { MobileFilterDrawer } from '../components/memory/MobileFilterDrawer';
import { ActiveFilters } from '../components/memory/ActiveFilters';
import { SearchResultsBanner } from '../components/memory/SearchResultsBanner';
import { MemoryCard } from '../components/memory/MemoryCard';
import { MemoryDetailPanel } from '../components/memory/MemoryDetailPanel';
import { ConversationPanel } from '../components/memory/ConversationPanel';
import { useMemories } from '../hooks/useMemories';
import { useSearchKeyboard } from '../hooks/useSearchKeyboard';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { InfiniteScrollList } from '../components/ui/InfiniteScrollList';
import { ReauthModal } from '../components/ui/ReauthModal';

export function MemoryExplorerPage() {
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectQuery = useRef('');

  const {
    filtered,
    query,
    setQuery,
    loading,
    loadingMore,
    hasMore,
    loadMoreMemories,
    loadMemories,
    searchFallback,
    searchPending,
    resolvedEntities,
    parsed,
    memoryStats,
    totalMemories,
    error,
    // New facet/filter state
    mode,
    setMode,
    facets,
    activeFilters,
    toggleFilter,
    setTimeRange,
    clearAllFilters,
    activePreset,
    applyPreset,
    conversation,
    sendMessage,
    clearConversation,
  } = useMemories();

  const needsRecoveryKey = !!memoryStats?.needsRecoveryKey;

  // Auto-select top result on new search
  useEffect(() => {
    if (!loading && query.trim() && filtered.length > 0 && lastAutoSelectQuery.current !== query) {
      lastAutoSelectQuery.current = query;
      setSelectedMemory(filtered[0]);
      setSelectedIndex(0);
    }
  }, [loading, query, filtered]);

  // Keyboard navigation
  useSearchKeyboard({
    inputRef,
    resultsRef,
    resultCount: filtered.length,
    selectedIndex,
    onSelectIndex: (i) => {
      setSelectedIndex(i);
      if (filtered[i]) setSelectedMemory(filtered[i]);
    },
    onOpenSelected: () => {
      if (filtered[selectedIndex]) setSelectedMemory(filtered[selectedIndex]);
    },
    onClose: () => {
      if (selectedMemory) setSelectedMemory(null);
      else if (filtersOpen) setFiltersOpen(false);
      else inputRef.current?.blur();
    },
    onToggleFilters: () => setFiltersOpen((v) => !v),
    onToggleMode: () => {
      setMode(mode === 'search' ? 'ask' : 'search');
    },
  });

  // Check if any filters are active
  const hasActiveFilters = useMemo(() => {
    const f = activeFilters;
    return (
      f.connectorTypes.length > 0 ||
      f.sourceTypes.length > 0 ||
      f.factualityLabels.length > 0 ||
      f.personNames.length > 0 ||
      f.timeRange.from !== null ||
      f.timeRange.to !== null
    );
  }, [activeFilters]);

  const handleRemoveFilter = (key: string, value: string) => {
    if (key === 'timeRange') {
      const newFrom = value === 'from' ? null : activeFilters.timeRange.from;
      const newTo = value === 'to' ? null : activeFilters.timeRange.to;
      setTimeRange(newFrom, newTo);
    } else {
      toggleFilter(key as any, value);
    }
  };

  if (needsRecoveryKey) {
    return (
      <PageContainer>
        <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
        <div className="mt-4 flex flex-col items-center justify-center gap-4 py-20 border-2 border-nb-border/40 bg-nb-surface/30">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-nb-text"
          >
            <rect x="3" y="11" width="18" height="11" rx="0" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="font-display text-lg text-nb-muted text-center max-w-md">
            Enter your recovery key to access your memories.
          </p>
          <button
            onClick={() => setReauthOpen(true)}
            className="px-5 py-2.5 border-2 border-nb-lime bg-nb-lime/20 font-display text-sm font-bold uppercase tracking-wider text-nb-lime hover:bg-nb-lime/40 cursor-pointer transition-colors"
          >
            Unlock
          </button>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <ReauthModal open={reauthOpen} onClose={() => setReauthOpen(false)} />
      <MobileFilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        facets={facets}
        activeFilters={activeFilters}
        onToggleFilter={toggleFilter}
        onTimeRangeChange={setTimeRange}
      />

      <div className="mt-4 flex flex-col h-[calc(100dvh-9rem)] sm:h-[calc(100dvh-10rem)]">
        {/* Search Header */}
        <SearchHeader
          query={query}
          onQueryChange={setQuery}
          mode={mode}
          onModeChange={(m) => {
            setMode(m);
            if (m === 'ask') clearConversation();
          }}
          activePreset={activePreset}
          onApplyPreset={applyPreset}
          resultCount={query.trim() ? filtered.length : totalMemories}
          loading={loading}
          pending={searchPending}
          onToggleFilters={() => setFiltersOpen(true)}
          inputRef={inputRef}
        />

        {/* Active filters bar */}
        {hasActiveFilters && (
          <div className="mt-2">
            <ActiveFilters
              {...activeFilters}
              onRemove={handleRemoveFilter}
              onClearAll={clearAllFilters}
            />
          </div>
        )}

        {/* 3-column layout */}
        <div className="mt-3 flex min-h-0 flex-1 gap-0">
          {/* Facet Sidebar — desktop only */}
          <div className="hidden md:block w-60 shrink-0 border-r-2 border-nb-border overflow-y-auto">
            <FacetSidebar
              facets={facets}
              activeFilters={activeFilters}
              onToggleFilter={toggleFilter}
              onTimeRangeChange={setTimeRange}
            />
          </div>

          {/* Results / Conversation */}
          <div ref={resultsRef} tabIndex={-1} className="flex-1 min-w-0 outline-none">
            {mode === 'search' ? (
              <div className="h-full overflow-y-auto px-3">
                <InfiniteScrollList
                  items={filtered}
                  renderItem={(m, i) => (
                    <MemoryCard
                      memory={m}
                      onClick={() => {
                        setSelectedMemory(m);
                        setSelectedIndex(i);
                      }}
                      selected={selectedMemory?.id === m.id}
                      topResult={i === 0 && !!query.trim()}
                    />
                  )}
                  keyExtractor={(m) => m.id}
                  hasMore={hasMore}
                  loading={loading}
                  loadingMore={loadingMore}
                  onLoadMore={loadMoreMemories}
                  disabled={!!query.trim()}
                  className="flex flex-col gap-3"
                  header={
                    !loading && query.trim() ? (
                      <SearchResultsBanner
                        resolvedEntities={resolvedEntities}
                        resultCount={filtered.length}
                        searchFallback={searchFallback}
                        query={query}
                        parsed={parsed}
                      />
                    ) : undefined
                  }
                  loadingSkeleton={<Skeleton variant="card" count={3} />}
                  emptyState={
                    error ? (
                      <EmptyState
                        icon="!"
                        title="Failed to Load"
                        subtitle={error}
                        action={{ label: 'Retry', onClick: loadMemories }}
                      />
                    ) : (
                      <EmptyState
                        icon="0"
                        title="No Memories Found"
                        subtitle="Try adjusting your filters"
                      />
                    )
                  }
                />
              </div>
            ) : (
              <ConversationPanel
                messages={conversation.messages}
                loading={conversation.loading}
                onSendMessage={sendMessage}
                onCitationClick={(id) => {
                  const mem = filtered.find((m) => m.id === id);
                  if (mem) setSelectedMemory(mem);
                }}
              />
            )}
          </div>

          {/* Detail Panel — desktop only */}
          {selectedMemory && (
            <div className="hidden md:block md:w-96 md:shrink-0 overflow-y-auto border-l-2 border-nb-border">
              <MemoryDetailPanel memory={selectedMemory} onClose={() => setSelectedMemory(null)} />
            </div>
          )}
        </div>

        {/* Mobile full-screen detail overlay */}
        <div
          className={cn(
            'fixed inset-0 z-50 bg-nb-bg overflow-y-auto md:hidden',
            selectedMemory ? 'block' : 'hidden',
          )}
        >
          <div className="p-4 border-b-4 border-nb-border flex items-center gap-3 bg-nb-surface">
            <button
              onClick={() => setSelectedMemory(null)}
              className="border-2 border-nb-border size-11 flex items-center justify-center hover:bg-nb-lime hover:text-black transition-colors cursor-pointer text-nb-text"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 3L5 8l5 5" />
              </svg>
            </button>
            <span className="font-display text-sm font-bold uppercase tracking-wider text-nb-text">
              Detail
            </span>
          </div>
          {selectedMemory && (
            <div className="p-4">
              <MemoryDetailPanel memory={selectedMemory} onClose={() => setSelectedMemory(null)} />
            </div>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
```

- [ ] **Step 2: Delete MemorySearchBar.tsx (replaced by SearchHeader)**

```bash
rm apps/web/src/components/memory/MemorySearchBar.tsx
```

- [ ] **Step 3: Remove MemorySearchBar imports from any other file**

Search for any remaining imports of `MemorySearchBar` and remove them (it was only imported in MemoryExplorerPage which is now rewritten).

- [ ] **Step 4: Run dev server and verify the page loads**

```bash
cd apps/web && pnpm dev
```

Open http://localhost:12412/memories — verify:

- 3-column layout renders (facets | results | detail)
- Search still works
- Mode toggle shows Search/Ask
- Presets row is visible

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/MemoryExplorerPage.tsx
git rm apps/web/src/components/memory/MemorySearchBar.tsx
git commit -m "feat(web): rewrite MemoryExplorerPage with 3-column faceted layout"
```

---

## Chunk 5: Integration Testing + Polish

### Task 17: Fix TypeScript errors and integration issues

- [ ] **Step 1: Run TypeScript check**

```bash
cd apps/web && npx tsc --noEmit
```

Fix any type errors found.

- [ ] **Step 2: Run API TypeScript check**

```bash
cd apps/api && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 3: Run existing test suites**

```bash
pnpm test -- --run
```

Fix any failing tests.

- [ ] **Step 4: Commit fixes**

Stage only the files you changed, then commit:

```bash
git commit -am "fix: resolve TypeScript errors from search UI overhaul"
```

---

### Task 18: Write unit tests for searchStore extensions

**Files:**

- Create: `apps/web/src/store/__tests__/memoryStore.facets.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useMemoryStore } from '../memoryStore';

describe('memoryStore facet extensions', () => {
  beforeEach(() => {
    const { clearAllFilters, setMode, clearConversation } = useMemoryStore.getState();
    clearAllFilters();
    setMode('search');
    clearConversation();
  });

  it('toggleFilter adds and removes values', () => {
    const store = useMemoryStore.getState();
    store.toggleFilter('connectorTypes', 'gmail');
    expect(useMemoryStore.getState().activeFilters.connectorTypes).toEqual(['gmail']);

    store.toggleFilter('connectorTypes', 'gmail');
    expect(useMemoryStore.getState().activeFilters.connectorTypes).toEqual([]);
  });

  it('applyPreset sets filters and toggles off', () => {
    const store = useMemoryStore.getState();
    store.applyPreset('facts_only');
    expect(useMemoryStore.getState().activeFilters.factualityLabels).toEqual(['FACT']);
    expect(useMemoryStore.getState().activePreset).toBe('facts_only');

    // Toggle off
    store.applyPreset('facts_only');
    expect(useMemoryStore.getState().activePreset).toBeNull();
    expect(useMemoryStore.getState().activeFilters.factualityLabels).toEqual([]);
  });

  it('clearAllFilters resets everything', () => {
    const store = useMemoryStore.getState();
    store.toggleFilter('connectorTypes', 'gmail');
    store.toggleFilter('sourceTypes', 'email');
    store.clearAllFilters();

    const { activeFilters } = useMemoryStore.getState();
    expect(activeFilters.connectorTypes).toEqual([]);
    expect(activeFilters.sourceTypes).toEqual([]);
  });

  it('setTimeRange updates time filters', () => {
    const store = useMemoryStore.getState();
    store.setTimeRange('2026-01-01T00:00:00Z', '2026-03-16T00:00:00Z');

    const { activeFilters } = useMemoryStore.getState();
    expect(activeFilters.timeRange.from).toBe('2026-01-01T00:00:00Z');
    expect(activeFilters.timeRange.to).toBe('2026-03-16T00:00:00Z');
  });

  it('mode toggles between search and ask', () => {
    const store = useMemoryStore.getState();
    expect(store.mode).toBe('search');
    store.setMode('ask');
    expect(useMemoryStore.getState().mode).toBe('ask');
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd apps/web && pnpm vitest run src/store/__tests__/memoryStore.facets.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/store/__tests__/memoryStore.facets.test.ts
git commit -m "test: add unit tests for memoryStore facet extensions"
```

---

### Task 19: E2E smoke test

- [ ] **Step 1: Open the app in browser**

Navigate to http://localhost:12412/memories

- [ ] **Step 2: Verify search mode**

1. Type a search query — results appear with facet counts in sidebar
2. Click a connector facet checkbox — results filter, active filter pill appears
3. Click "Clear all" — filters reset
4. Click "EMAILS" preset — source filter applied
5. Click it again — preset toggles off

- [ ] **Step 3: Verify Ask mode**

1. Click "ASK" toggle
2. Type a question — conversation message appears
3. AI response renders (or error if Typesense conversation model not configured)
4. Citations show below the answer

- [ ] **Step 4: Verify keyboard shortcuts**

1. Press `/` — search input focuses
2. Click into results area, press `j`/`k` — selection moves
3. Press `Enter` — detail panel opens
4. Press `Esc` — detail panel closes

- [ ] **Step 5: Verify mobile**

1. Resize to mobile width
2. Filter button appears, click it — drawer slides in
3. Detail overlay works on tap

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: Phase 7 search UI overhaul complete"
```
