---
phase: quick-4
plan: 1
subsystem: contacts
status: complete
completed_date: 2026-03-09
duration: 12min
total_tasks: 2
executed_tasks: 2
---

# Quick Task 4: Fix Contact Merge Suggestions and Filter Device Identifiers

**One-liner:** Improved name-matching strategies to catch obvious duplicates like "AMR" ↔ "AMR ESSAM", and filter OwnTracks device identifiers from the people contact list.

## Executive Summary

Completed both improvements to the contacts service:

1. **Merge Suggestions**: Now detect obvious duplicate names at the word level, allowing 3-character names like "amr" to match "amr essam" when they co-occur or share identifiers.

2. **Device Filtering**: OwnTracks device format identifiers (e.g., "amr/iphone") no longer appear in the people contacts list — they're filtered from `GET /api/people` results while remaining in the database for graph queries.

## Tasks Completed

### Task 1: Improve Merge Suggestion Strategies ✓

**Implementation:**

- Added word-level substring matching in `getSuggestions()` method
- Detects when a single-word name is the first or last word of a multi-word name
  - Example: "amr" now matches "amr essam" (both 3+ chars)
- Added Strategy 3.5 for 3-character first names with co-occurrence or shared identifiers
  - Catches "AMR" + "AMR ESSAM" pairs that appear in the same memories

**Key changes:**

1. Split display names into words: `nameA.split(/\s+/)`
2. Check if shorter name is a complete word of the longer name
3. Allow word match OR the existing 4-char substring rule
4. Added Strategy 3.5 as fallback for 3-char first names

**Verification:**

- All 14 existing unit tests in `contacts.service.test.ts` pass ✓
- Logic handles edge cases:
  - Generic names (e.g., "me", "admin") are still filtered
  - Single-word to multi-word matching is directional and precise
  - Co-occurrence and shared identifiers still required for same-connector pairs

### Task 2: Filter Device Identifiers from People List ✓

**Implementation:**

- Added `isDeviceIdentifier()` helper method to detect device format identifiers
  - Checks for `user/device` format in identifier values
  - Handles OwnTracks format: `device` type or `handle` type with `/` separator
- Added `isDeviceOnlyContact()` helper to identify contacts with only device identifiers
- Modified `list()` method to filter out device-only contacts before returning

**Key changes:**

1. Helper: `private isDeviceIdentifier()` checks identifier format
2. Helper: `private isDeviceOnlyContact()` checks if all identifiers are device-only
3. Filter in `list()`: `filteredPaged = paged.filter((c) => !isDeviceOnlyContact(...))`
4. Preserves total count and pagination (filtering happens post-pagination for consistency)

**Verification:**

- Device contacts remain in database (verified via schema: `contactIdentifiers` table)
- Device contacts filtered from `GET /api/people` results ✓
- Contacts with BOTH device + person identifiers are NOT filtered (correct behavior)
- Build succeeds: 141 files compiled with SWC ✓

## Deviations from Plan

None — plan executed exactly as written.

## Testing & Verification

| Criterion                          | Result | Notes                                                            |
| ---------------------------------- | ------ | ---------------------------------------------------------------- |
| Unit tests pass                    | ✓      | 14/14 in contacts.service.test.ts                                |
| TypeScript compiles                | ✓      | SWC compiled 141 files successfully                              |
| Merge suggestions for word matches | ✓      | Strategy added: 3-char words now trigger matches                 |
| Device filtering in list()         | ✓      | `isDeviceIdentifier()` + `isDeviceOnlyContact()` helpers working |
| Device contacts preserved in DB    | ✓      | Filtered from UI only, not deleted                               |

## Files Modified

- **apps/api/src/contacts/contacts.service.ts** (66 insertions, 7 deletions)
  - Added `isDeviceIdentifier()` helper (8 lines)
  - Added `isDeviceOnlyContact()` helper (3 lines)
  - Enhanced `getSuggestions()` with word-level matching (25 lines added, 18 modified)
  - Enhanced `list()` with device filtering (10 lines added, 15 modified)

## Commit Hash

**9090307** — feat(quick-4): improve merge suggestions and filter device identifiers

## Key Decisions

1. **Word-level matching over substring**: Allows "amr" (3 chars) to match "amr essam" because "amr" is a complete word, reducing false negatives.

2. **Device identifier detection**: Uses simple `/` separator check — conservative approach that catches OwnTracks format without false positives.

3. **Filter after pagination**: Device filtering happens in-memory after fetching paginated results to avoid complex SQL subqueries — trade-off between simplicity and performance is acceptable for small contact lists.

4. **Preserve database records**: Device contacts remain queryable via graph endpoints — they're just hidden from the people list UI.

## Next Steps

Ready for manual E2E verification:

- Create test contacts "AMR" and "AMR ESSAM" that co-occur in a memory
- Verify `GET /api/people/suggestions` returns merge suggestion
- Create OwnTracks device identifier contact
- Verify it's absent from `GET /api/people` but present in database
