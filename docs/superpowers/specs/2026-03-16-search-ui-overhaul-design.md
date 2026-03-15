# Phase 7: Search Experience UI Overhaul

**Date**: 2026-03-16
**Status**: Draft
**Scope**: Complete redesign of the Memory Explorer page — faceted search, conversation mode, improved result display

---

## 1. Problem Statement

The current Memory Explorer is a functional search interface but lacks the depth expected from a personal memory system with 100k+ memories. Specific gaps:

- **No faceted filtering** — only a row of source-type buttons (EMAIL, MESSAGE, etc.). No connector, factuality, people, or temporal filters.
- **No conversation mode** — Typesense conversation/RAG is wired in the backend but has no frontend surface.
- **Flat result display** — MemoryCard shows text excerpt + score bar but doesn't leverage entities, claims, people, or factuality in the result UI.
- **No presets/quick filters** — the POC has presets (recent emails, pinned, facts only) that never made it to the React app.
- **No autocomplete** — search starts only after 3 chars + 500ms debounce, no type-ahead. (The 500ms debounce is kept intentionally in this phase; autocomplete is deferred to a future phase.)

## 2. Design Goals

1. **Faceted sidebar** with live counts — connector type, source type, factuality, people, time range
2. **Conversation mode** — toggle between "Search" (ranked results) and "Ask" (RAG conversational answers with citations)
3. **Rich result cards** — entity tags, people avatars, factuality badge, connector icon, temporal context
4. **Search presets** — quick-access saved queries (recent emails, photos this week, pinned memories, facts only)
5. **Keyboard-first** — `/` to focus search, `j/k` to navigate results, `Enter` to open detail, `Esc` to close
6. **Mobile-responsive** — facets collapse into a filter drawer on mobile

## 3. Architecture

### 3.1 Page Layout

```
+------------------------------------------------------------------+
|  [Search/Ask toggle]  [ Search Input .............. ]  [Presets]  |
+------------------------------------------------------------------+
|  Facets Sidebar  |  Results Area           |  Detail Panel (md+)  |
|  (collapsible)   |                         |                      |
|                  |  [SearchResultsBanner]   |  [MemoryDetailPanel] |
|  Connector ▼     |  [MemoryCard]           |                      |
|   gmail (342)    |  [MemoryCard]           |                      |
|   whatsapp (89)  |  [MemoryCard]           |                      |
|   imessage (45)  |  ...infinite scroll     |                      |
|                  |                         |                      |
|  Source Type ▼   |  --- OR in Ask mode --- |                      |
|   email (342)    |                         |                      |
|   message (134)  |  [ConversationPanel]    |                      |
|                  |  AI answer + citations  |                      |
|  Factuality ▼    |  [follow-up input]      |                      |
|   FACT (200)     |                         |                      |
|   UNVERIFIED (3) |                         |                      |
|                  |                         |                      |
|  People ▼        |                         |                      |
|   Amr (500)      |                         |                      |
|   John (120)     |                         |                      |
|                  |                         |                      |
|  Time Range ▼    |                         |                      |
|   [from] [to]    |                         |                      |
+------------------------------------------------------------------+
```

**Desktop** (md+): 3-column — facets (240px fixed) | results (flex) | detail (384px fixed, shown when memory selected)
**Tablet** (sm-md): 2-column — results + detail overlay
**Mobile**: single column — filter drawer (slide from left), results, detail overlay (slide from right)

### 3.2 New Components

| Component             | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `SearchHeader`        | Search input + mode toggle (Search/Ask) + presets row                  |
| `FacetSidebar`        | Collapsible faceted filter panel with live counts                      |
| `FacetGroup`          | Individual facet section (connector, source, factuality, people, time) |
| `FacetCheckbox`       | Single facet option with count badge                                   |
| `TimeRangeFacet`      | Date range picker (from/to inputs)                                     |
| `PeopleFacet`         | People facet with avatar thumbnails                                    |
| `SearchPresets`       | Horizontal scrollable preset chips                                     |
| `ConversationPanel`   | RAG conversation view — AI answer + source citations + follow-up input |
| `ConversationMessage` | Single message in conversation (user query or AI response)             |
| `CitationCard`        | Inline citation linking to a memory result                             |
| `MemoryCardEnhanced`  | Upgraded MemoryCard with entity tags, people, factuality badge         |
| `MobileFilterDrawer`  | Slide-out drawer containing FacetSidebar on mobile                     |
| `ActiveFilters`       | Horizontal bar showing active filter pills with dismiss buttons        |

### 3.3 Modified Components

| Component             | Changes                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `MemoryExplorerPage`  | Rewrite — new 3-column layout, state management for facets + conversation        |
| `MemorySearchBar`     | Replace with `SearchHeader` — adds mode toggle, removes inline source buttons    |
| `MemoryCard`          | Enhance with entity tags, people avatars, factuality badge, better score display |
| `SearchResultsBanner` | Add active filter pills, result count with facet breakdown                       |

### 3.4 State Management

**Extend `memoryStore.ts`** (not a new store — avoids split-brain with existing search state)

The existing `memoryStore` already owns `query`, `filters`, `memories`, `loading`, `searchFallback`, `resolvedEntities`, `parsed`. We extend it in-place with new fields:

```typescript
// New fields added to existing memoryStore
interface MemoryStoreExtensions {
  // Mode
  mode: 'search' | 'ask';
  setMode: (m: 'search' | 'ask') => void;

  // Facets (from Typesense facet_counts in search response)
  facets: {
    connectorType: FacetValue[]; // { value: string; count: number }
    sourceType: FacetValue[];
    factuality: FacetValue[];
    people: FacetValue[];
  };

  // Active filters (replaces existing simple filters object)
  activeFilters: {
    connectorTypes: string[];
    sourceTypes: string[];
    factualityLabels: string[];
    personNames: string[];
    timeRange: { from: string | null; to: string | null };
    pinned: boolean | null;
  };
  setFilter: (key: keyof ActiveFilters, values: string[]) => void;
  toggleFilter: (key: keyof ActiveFilters, value: string) => void;
  setTimeRange: (from: string | null, to: string | null) => void;
  clearAllFilters: () => void;

  // Presets
  activePreset: string | null;
  applyPreset: (presetId: string) => void; // clicking active preset toggles it off

  // Conversation mode (inherits activeMemoryBankId from memoryBankStore)
  conversation: {
    id: string | null;
    messages: ConversationMessage[];
    loading: boolean;
  };
  sendMessage: (query: string) => Promise<void>;
  clearConversation: () => void;
}
```

**Fields removed from memoryStore**: `filters` (replaced by `activeFilters`), source-only filter state.
**Fields kept**: `memories`, `graphData`, `memoryStats`, `totalMemories`, `loading`, `searchFallback`, `resolvedEntities`, `parsed`.

The `useMemories` hook reads `activeFilters` instead of the old `filters` object. The `memoryBankStore.activeMemoryBankId` is passed to both search and ask API calls.

### 3.5 API Changes

**Faceted search endpoint** — extend `POST /memories/search`:

The Typesense search already supports `facet_by` — we need to:

1. Add `facet_by: 'connector_type,source_type,factuality_label,people'` to the Typesense search params
2. Add `factuality_label` as a new top-level `string` facet field to the Typesense collection schema (requires migration script to backfill from existing memories' factuality JSON)
3. Return `facet_counts` in the API response (currently stripped)
4. Replace the loose `filters?: Record<string, string>` DTO with a typed DTO:

```typescript
// SearchFiltersDto (replaces Record<string, string>)
{
  connectorTypes?: string[];       // multi-select, OR within group
  sourceTypes?: string[];          // multi-select, OR within group
  factualityLabels?: string[];     // multi-select, OR within group
  personNames?: string[];          // multi-select, OR within group (matches people field)
  timeRange?: {
    from?: string;                 // ISO 8601
    to?: string;                   // ISO 8601
  };
  pinned?: boolean;
}
```

**Conversation endpoint** — new `POST /memories/ask`:

```typescript
// Request
{
  query: string;
  conversationId?: string;   // for multi-turn
  memoryBankId?: string;
}

// Response
{
  answer: string;              // RAG-generated answer
  conversationId: string;      // for follow-ups
  citations: ApiMemoryItem[];  // source memories
}
```

This wraps the existing `TypesenseService.conversationSearch()` which already supports conversation model + multi-turn via `conversationId`.

**Streaming**: The ask endpoint uses SSE (Server-Sent Events) to stream the RAG answer token-by-token. The existing WebSocket gateway (`/events`) is used for job progress — SSE is simpler for this request/response pattern. If Typesense returns the full answer at once (non-streaming), we return it as a single SSE event. Frontend displays a pulsing indicator until the first token arrives.

**Error handling for Ask mode**:

- Typesense unreachable: return `{ error: 'Search service unavailable', code: 'SEARCH_DOWN' }`, frontend shows inline error with retry button
- Conversation model not configured: return `{ error: 'Conversation mode not available', code: 'NO_CONV_MODEL' }`, frontend disables Ask toggle with tooltip
- Empty results (no relevant memories): return answer explaining no relevant memories found, with empty citations

### 3.6 Facet Definitions

| Facet       | Source                                                                              | Type                      | Behavior                      |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------- | ----------------------------- |
| Connector   | Typesense `connector_type` facet                                                    | Checkbox list             | Multi-select, OR within group |
| Source Type | Typesense `source_type` facet                                                       | Checkbox list             | Multi-select, OR within group |
| Factuality  | Typesense `factuality_label` field (new, requires schema migration + backfill)      | Checkbox list             | Multi-select                  |
| People      | Typesense `people` field (already exists as string array — use `facet_by` directly) | Checkbox list with avatar | Multi-select                  |
| Time Range  | `event_time` field                                                                  | Date range (from/to)      | AND filter                    |

Facets with zero matches for current query are shown greyed out (not hidden) to maintain spatial stability.

### 3.7 Search Presets

Hardcoded presets, each maps to a filter + optional sort:

| Preset        | Filters                                | Sort              |
| ------------- | -------------------------------------- | ----------------- |
| Recent Emails | `sourceType: ['email']`                | `event_time desc` |
| Recent Photos | `sourceType: ['photo']`                | `event_time desc` |
| Pinned        | `pinned: true`                         | `importance desc` |
| Facts Only    | `factuality: ['FACT']`                 | `final desc`      |
| This Week     | `timeRange: { from: 7d ago, to: now }` | `event_time desc` |

## 4. Visual Design

All design follows the existing neobrutalist system defined in `index.css`. No new design tokens needed.

### 4.1 Facet Sidebar

- **Background**: `bg-nb-surface` with `border-r-2 border-nb-border`
- **Section headers**: `font-display text-xs font-bold uppercase tracking-wider text-nb-muted`
- **Checkboxes**: custom square checkboxes (no border-radius), `border-2 border-nb-border`, checked state fills with connector color
- **Counts**: `text-nb-muted font-mono text-xs` right-aligned
- **Collapse/expand**: section header is clickable, chevron rotates, smooth height transition
- **Width**: 240px on desktop, full-width drawer on mobile

### 4.2 Search Header

- **Mode toggle**: Two hard-bordered buttons side by side — "SEARCH" and "ASK". Active state: `bg-nb-lime text-black`, inactive: `bg-transparent text-nb-muted`
- **Input**: Same as current but wider (fills remaining space). Monospace, `border-2 border-nb-border`, focus: `border-nb-lime`
- **Presets row**: Horizontal scroll of chips below the input. `border-2 border-nb-border px-3 py-1 font-mono text-xs uppercase`. Active: `bg-nb-lime/20 border-nb-lime`

### 4.3 Enhanced Memory Card

Additions to current MemoryCard:

- **Entity tags**: horizontal row of small pills below text. `border border-nb-border/50 text-[10px] font-mono px-1.5 py-0.5`. Color-coded by entity type (PERSON=pink, PLACE=blue, ORG=purple, DATE=yellow, fallback for unknown types=nb-gray)
- **People row**: small avatar circles (16px) with initials fallback, max 3 shown + "+N" overflow
- **Factuality badge**: top-right corner. FACT=green dot, UNVERIFIED=yellow dot, FICTION=red dot. Minimal — just a colored indicator
- **Score display**: replace the full score bar with a small `text-[10px] font-mono text-nb-muted` showing the final score as a number (e.g. "0.82")

### 4.4 Conversation Panel (Ask Mode)

- **Message bubbles**: no bubbles — flat layout. User queries right-aligned in `text-nb-lime font-display`, AI responses left-aligned in `text-nb-text font-body`
- **Citations**: inline `[1]` markers in AI text, hover shows preview card. Citation list below each AI message as small MemoryCards
- **Follow-up input**: pinned to bottom of panel, same style as search input but with "Ask a follow-up..." placeholder
- **Thinking state**: pulsing lime dots animation while waiting for RAG response

### 4.5 Active Filters Bar

- Horizontal bar between search header and results
- Each active filter shown as a pill: `bg-nb-surface border-2 border-nb-border px-2 py-1 font-mono text-xs` with an `x` dismiss button
- "Clear all" link at the end when >1 filter active

### 4.6 Mobile Filter Drawer

- Triggered by a filter icon button in the search header (visible < md)
- Slides from left edge, full height, `w-72 bg-nb-bg border-r-4 border-nb-border`
- Header: "FILTERS" + close button
- Contains same FacetSidebar content
- Backdrop overlay: `bg-black/50`

## 5. Keyboard Shortcuts

| Key                 | Action                                                  |
| ------------------- | ------------------------------------------------------- |
| `/`                 | Focus search input                                      |
| `Esc`               | Close detail panel / clear search / close filter drawer |
| `j` / `k`           | Navigate results (down/up)                              |
| `Enter`             | Open selected result in detail panel                    |
| `Tab` (in Ask mode) | Switch between search input and follow-up input         |
| `Ctrl+Shift+F`      | Toggle facet sidebar                                    |
| `Ctrl+Shift+A`      | Toggle Search/Ask mode                                  |

Implemented via a `useSearchKeyboard` hook that registers global listeners. `j/k` navigation only active when the results list container has focus (user must click into results area or press `Esc` from search input first). `/` always works regardless of focus. This avoids accidental navigation while typing.

## 6. Data Flow

### 6.1 Search Mode

```
User types query
  → 500ms debounce
  → searchStore: set query + activeFilters
  → API call: POST /memories/search { query, filters: { connectorType, sourceType, ... }, limit: 20 }
  → Typesense: hybrid search with facet_by
  → Response: { items, facet_counts, resolvedEntities, parsed }
  → searchStore: update results + facets
  → UI: render facet counts, result list, auto-select first result
```

### 6.2 Ask Mode

```
User types question
  → searchStore.sendMessage(query)
  → API call: POST /memories/ask { query, conversationId? }
  → Typesense: conversationSearch (hybrid + RAG)
  → Response: { answer, conversationId, citations }
  → searchStore: append to conversation.messages
  → UI: render AI answer with inline citations
```

### 6.3 Facet Interaction

```
User clicks facet checkbox (e.g. "gmail")
  → searchStore.toggleFilter('connectorTypes', 'gmail')
  → Triggers re-search with updated filters
  → All facet counts update to reflect narrowed results
  → Active filter pill appears in ActiveFilters bar
```

### 6.4 Pagination

Typesense facet counts reflect the full query result set regardless of pagination — they are not limited to the current page. Items are paginated with `page` parameter (1-based). Infinite scroll increments `page` and appends results. Facet counts do NOT change on page load — they only update when the query or filters change.

## 7. File Structure

```
components/memory/
  SearchHeader.tsx           — search input + mode toggle + presets
  SearchPresets.tsx          — preset chip row
  FacetSidebar.tsx           — collapsible facet panel container
  FacetGroup.tsx             — individual collapsible facet section
  FacetCheckbox.tsx          — single checkbox with count
  TimeRangeFacet.tsx         — date range from/to inputs
  PeopleFacet.tsx            — people facet with avatars
  ActiveFilters.tsx          — active filter pills bar
  MobileFilterDrawer.tsx     — slide-out filter drawer
  ConversationPanel.tsx      — RAG conversation view
  ConversationMessage.tsx    — single conversation message
  CitationCard.tsx           — inline citation preview
  MemoryCard.tsx             — enhanced (modify existing)
  MemoryDetailPanel.tsx      — keep as-is
  MemorySearchBar.tsx        — delete (replaced by SearchHeader)
  SearchResultsBanner.tsx    — modify (add facet breakdown)

store/
  memoryStore.ts             — extend: add facets, activeFilters, conversation, presets

hooks/
  useSearchKeyboard.ts       — new: keyboard shortcut handler
  useSearch.ts               — modify: add facet params, conversation support
  useMemories.ts             — modify: integrate searchStore filters

pages/
  MemoryExplorerPage.tsx     — rewrite: 3-column layout

api/ (backend)
  memory.controller.ts       — add POST /memories/ask endpoint
  memory.service.ts          — add facet_by to search, expose facet_counts
  typesense.service.ts       — add facet fields to search params
  dto/                       — add AskMemoriesDto
```

## 8. Migration Strategy

- **No breaking changes** — existing MemoryCard, MemoryDetailPanel, and search API remain backwards-compatible
- **MemorySearchBar** replaced by SearchHeader but same props flow
- **memoryStore** extended in-place — old `filters` object replaced by typed `activeFilters`, new `facets` + `conversation` + `mode` fields added
- **useMemories** hook updated to read from `memoryStore.activeFilters` instead of the old `filters` object
- **Incremental rollout**: search mode works first (facets + enhanced cards), conversation mode second

## 9. Testing Strategy

- **Unit tests**: searchStore (filter toggling, preset application, conversation state), FacetGroup (collapse/expand), useSearchKeyboard (key handlers)
- **Integration tests**: MemoryExplorerPage renders with mock data, facet clicks trigger re-search, conversation mode sends API call
- **E2E**: browser test — search, click facet, verify results filter, switch to Ask mode, verify RAG response renders

## 10. Out of Scope

- Graph visualization overhaul (separate phase)
- Geo/location facet with map (future — backend supports it, UI deferred)
- Saved searches / custom presets (future)
- Search history / recent queries (future)
- Autocomplete / type-ahead suggestions (deferred — requires new Typesense endpoint)
