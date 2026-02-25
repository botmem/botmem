# Immich Connector Fixes + Contacts Page Design

## Problem

1. Immich connector emits `sourceType: 'file'` which bypasses contact resolution — Immich people (face recognition) never become contacts
2. No contacts page in the frontend despite API endpoints existing
3. Contacts lack avatars, merge is a stub, no suggested merges

## Design

### Immich Connector Fixes

Three fixes in `EmbedProcessor`, not the connector package itself:

1. **Fix contact resolution bypass** — After enqueuing FileProcessor for `sourceType: 'file'`, still run `resolvePhotosContacts()` before returning. Links Immich people to contacts system.
2. **Download + store avatar** — When resolving Immich person contacts, download face thumbnail (`/api/people/{personId}/thumbnail`) with API key auth, store as base64 data URI in `contacts.avatars` JSON array.
3. **Fix test** — Update `immich.test.ts` to expect `sourceType: 'file'`.

### Contacts Schema Changes

Migrate `contacts.avatarUrl` (text) → `contacts.avatars` (JSON text). Array of `{ url: string, source: string }`.

```json
[
  { "url": "data:image/jpeg;base64,...", "source": "immich" },
  { "url": "data:image/jpeg;base64,...", "source": "gmail" }
]
```

Each connector appends its avatar during contact resolution. Existing `avatarUrl` values migrated to `[{ url, source: "unknown" }]`.

Add `mergeDismissals` table: `(contactId1 TEXT, contactId2 TEXT, createdAt TEXT)` — tracks dismissed merge suggestions.

### Contacts API Enhancements

| Endpoint | Method | Purpose |
|---|---|---|
| `/contacts` | GET | List contacts with identifiers (fix N+1 query) |
| `/contacts/:id` | GET | Single contact with identifiers |
| `/contacts/:id` | PATCH | Update displayName, avatars, metadata |
| `/contacts/:id` | DELETE | Remove contact, unlink memories |
| `/contacts/:id/merge` | POST | Merge source contact into target: move identifiers + memory links, delete source |
| `/contacts/:id/memories` | GET | Linked memories |
| `/contacts/search` | POST | Search by name or identifier |
| `/contacts/suggestions` | GET | Suggested merge pairs |
| `/contacts/suggestions/:id/dismiss` | POST | Dismiss a suggestion |

### Merge Suggestion Algorithm

Case-insensitive substring match on displayName across contacts from different connectors:
- Normalize: lowercase, trim
- For each pair from different connectors: if `nameA.includes(nameB)` or `nameB.includes(nameA)` → suggest
- Exclude dismissed pairs
- Returns `[{ contact1, contact2, reason: "Name overlap: 'amr' ⊂ 'amr essam'" }]`

### Contacts Page (Frontend, Neobrutal)

Three sections, top to bottom:

**Suggested Merges Banner** — Collapsible, only visible when suggestions exist. Each suggestion shows two contact cards side-by-side with MERGE and DISMISS buttons. Shows avatars (face thumbnail or initials fallback), names, identifier badges.

**Contact List** — Search bar at top. Grid of contact cards: avatar, display name, identifier badges by type, connector source icons, memory count. Click opens detail panel.

**Contact Detail Panel** — Slides in from right. Editable display name. Avatar gallery (all sources, reorderable for primary). Identifier list with remove. Add identifier form. Linked memories list (date + snippet + source icon). Metadata/notes field. Delete button with confirmation.

All neobrutal: `border-3 border-nb-border`, `font-display` uppercase headings, `font-mono` values, `shadow-nb`, `Badge` components, `nb-*` color tokens.

### Data Flow

```
Immich Sync
  → emits sourceType: 'file' with content.metadata.people[]
  → EmbedProcessor:
      ├ Create Memory in SQLite
      ├ Resolve contacts from people[] (FIXED: no longer bypassed)
      │   ├ For each person: resolveContact([
      │   │   {type: 'immich_person_id', value: id},
      │   │   {type: 'name', value: name}
      │   │ ])
      │   ├ Download face thumbnail, store as base64 in contacts.avatars
      │   └ Link contact → memory with role 'mentioned'
      ├ Enqueue file job (VL description + embedding)
      └ Enqueue enrich job

Merge Suggestions (GET /contacts/suggestions)
  → Group contacts by normalized name tokens
  → Case-insensitive substring match across different connectors
  → Exclude dismissed pairs
  → Return ranked suggestion list

Contact Merge (POST /contacts/:id/merge)
  → Move all identifiers from source → target
  → Move all memoryContacts from source → target
  → Merge avatars arrays (target first, then source)
  → Keep longest displayName
  → Delete source contact
```

### Files Changed

**Backend:**
- `apps/api/src/memory/embed.processor.ts` — Run contact resolution for `sourceType: 'file'`
- `apps/api/src/contacts/contacts.service.ts` — `updateContact()`, real `mergeContacts()`, `getSuggestions()`, `deleteContact()`, `dismissSuggestion()`, fix N+1 list, avatar download helper
- `apps/api/src/contacts/contacts.controller.ts` — New endpoints
- `apps/api/src/db/schema.ts` — `avatarUrl` → `avatars` migration, `mergeDismissals` table

**Frontend:**
- `apps/web/src/pages/ContactsPage.tsx` — New page
- `apps/web/src/components/contacts/ContactCard.tsx`
- `apps/web/src/components/contacts/ContactDetailPanel.tsx`
- `apps/web/src/components/contacts/MergeSuggestionRow.tsx`
- `apps/web/src/store/contactStore.ts` — New Zustand store
- `apps/web/src/lib/api.ts` — New methods
- `apps/web/src/App.tsx` — Route
- `apps/web/src/components/layout/Sidebar.tsx` — Nav item

**Tests:**
- `packages/connectors/photos-immich/src/__tests__/immich.test.ts` — Fix sourceType assertion
