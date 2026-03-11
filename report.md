# Phase 35 — Data Sync & Pipeline Verification Report

## Sync Summary

| Connector | Raw Events | Memories | Pipeline Complete | Embedded | Contacts |
|-----------|------------|----------|-------------------|----------|----------|
| Gmail     | 500        | 500      | 494               | 500      | 137      |
| Slack     | 609        | 248      | 36                | 248      | 27       |
| WhatsApp  | 500        | 3        | 3                 | 3        | 2        |
| iMessage  | 0          | 0        | 0                 | 0        | 0        |
| **Total** | **1,609**  | **751**  | **533**           | **751**  | **166**  |

- Total contacts: 691 (528 orphans — no memories linked)
- Total identifiers: 1,070
- Memory links: 1,347
- Qdrant vectors: 749
- Date range: Gmail Dec 2025–Jan 2026, Slack Mar 2025–Mar 2026, WhatsApp Mar 2026
- No duplicate source_ids (good)
- No orphan memories (every memory has ≥1 contact)
- 0 pinned, 0 recalled (expected for fresh data)

### Memory Contact Roles
| Role | Count |
|------|-------|
| sender | 1,070 |
| participant | 728 |
| recipient | 497 |
| mentioned | 149 |

### Factuality Distribution
| Label | Count |
|-------|-------|
| (empty/encrypted) | 724 |
| UNVERIFIED | 27 |

Only 27 out of 751 have a readable factuality label — rest are encrypted or null.

---

## Issues Found

### 1. `enrichedAt` never set by EnrichProcessor ✅ FIXED
- **Severity**: Medium
- **File**: `apps/api/src/memory/enrich.processor.ts:114`
- **Problem**: `pipelineComplete` set to `true` but `enrichedAt` not set. Backfill endpoint uses `enrichedAt IS NULL` to find un-enriched memories — so all appeared un-enriched.
- **Fix**: Added `enrichedAt: new Date()` to the `.set()` call.
- **Backfill**: Updated 470 existing rows.

### 2. Contact FK race condition in concurrent embed workers ✅ FIXED
- **Severity**: High
- **File**: `apps/api/src/contacts/contacts.service.ts`
- **Problem**: `deduplicateByExactName` deletes contacts while concurrent embed workers insert identifiers for deleted contact → FK violation.
- **Fix**: Post-dedup existence check + display name fallback in retry loop.
- **Status**: No FK errors observed after fix.

### 3. WhatsApp: 500 raw events → only 3 memories (99.4% drop)
- **Severity**: HIGH
- **Problem**: 500 raw events ingested but only 3 converted to memories. 497 raw events have no corresponding memory. All 3 existing memories are embedded and pipeline-complete.
- **Investigate**: Check if embed jobs were created for all raw events, or if SyncProcessor failed to enqueue them. Check API logs for WhatsApp embed failures.

### 4. Slack: 609 raw events → 248 memories (59% drop)
- **Severity**: HIGH
- **Problem**: 609 raw events (484 msg + 125 file) → 248 memories (still processing). May be partially queue backlog. Need to wait for queue drain and recheck.
- **Investigate**: After queue drains, check final count. If still a gap, check SyncProcessor enqueue logic.

### 5. Encryption inconsistency — memories stored as plaintext
- **Severity**: HIGH
- **Problem**: Mixed encryption state:
  - Gmail: 460 encrypted, 40 plaintext (key_version=0)
  - Slack: 74 encrypted, 141 plaintext (majority plaintext!)
  - WhatsApp: 2 encrypted, 1 plaintext
- **Detail**: Plaintext memories include readable content (GitHub alerts, Slack messages with names/work topics, WhatsApp messages with phone numbers). `encryptMemoryAtRest` is fire-and-forget at line 106 — failures are logged as warnings but the pipeline continues.
- **Investigate**: Check if user key is loaded in memory, if encryption errors are in API logs, and why some succeed while others fail.

### 6. Entity type misclassification (organizations as persons)
- **Severity**: Low
- **File**: Contact resolution / enrichment pipeline
- **Problem**: "noon", "GitHub", "HSBC UAE", "Justlife", "Spaceship", "Google", "Cursor", "Notion Team" all `entity_type: person`.
- **Investigate**: Connector doesn't pass entity type, and enrichment doesn't infer it.

### 7. iMessage sync returns 0 events
- **Severity**: Medium
- **Problem**: iMessage connector completed instantly with 0 events. Two sync jobs both 0/0.
- **Investigate**: Check iMessage DB path config, whether connector can access `chat.db`, and if Full Disk Access is granted.

### 8. 528 orphan contacts (no memory associations)
- **Severity**: Low
- **Problem**: 528 out of 691 contacts have no memory_contacts link. These were likely created then merged — the winner contact kept the links, but orphaned contacts from failed merges were left behind.
- **Investigate**: May be artifacts of the FK race condition (issue #2). Could clean up with `DELETE FROM contacts WHERE id NOT IN (SELECT contact_id FROM memory_contacts)`.

### 9. DEBUG_SYNC_LIMIT not effective (500 instead of 50)
- **Severity**: Low
- **Problem**: Syncs pulled 500 events instead of expected 50. Caused by syncs starting before API restart picked up rebuilt connector-sdk.
- **Status**: Operational issue, not a code bug.

### 10. Slack pipeline completion very low (36/248 = 14.5%)
- **Severity**: Medium
- **Problem**: 248 Slack memories exist with `embedding_status=done` but only 36 are `pipeline_complete`. Enrich queue still processing (177 waiting). May resolve when queue drains.
- **Investigate**: Recheck after queue drains. If gap persists, enrich processor may be failing for Slack memories.

---

## Data Quality Observations (not issues)

- **Entities/claims/metadata are encrypted at rest** — can't inspect quality from SQL. The encrypted fields look correct (base64 with IV prefix).
- **All weights are populated** — 751/751 memories have weights (good).
- **Memory links working** — 1,347 links created across memories (supports/related/contradicts relationships).
- **Contact roles well-distributed** — sender, participant, recipient, mentioned all populated.
- **No duplicate source_ids** — deduplication working correctly.

---

## Fixes Applied (not yet committed)
1. `apps/api/src/contacts/contacts.service.ts` — race condition fix (post-dedup verify + retry fallback)
2. `apps/api/src/memory/enrich.processor.ts` — added `enrichedAt` to pipeline completion update
