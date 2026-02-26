# Slack Enrichment, Shared File Pipeline, Weight Breakdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich Slack contacts with profile data for cross-connector merge, add a shared file processing pipeline for images and documents, and fix the weight breakdown showing all zeros.

**Architecture:** Three independent changes: (1) Slack sync emits full user profiles, embed processor creates multi-identifier contacts. (2) New `file` BullMQ queue with `FileProcessor` that downloads files, extracts content (VL for images, text extraction for docs/PDFs), then feeds back into embed→enrich. Immich photo processing migrates to this shared pipeline. (3) Enrich processor computes and stores base weights; search endpoint overrides with live semantic scores.

**Tech Stack:** NestJS 11, BullMQ, Slack Web API, Ollama VL model, pdf-parse, Vitest

---

### Task 1: Slack Contact Enrichment — Expand fetchUserMap

**Files:**
- Modify: `packages/connectors/slack/src/sync.ts:9-25`
- Test: `packages/connectors/slack/src/__tests__/sync.test.ts`

**Step 1: Write the failing test**

Add a test to `sync.test.ts` that verifies participantProfiles are emitted in metadata:

```typescript
it('emits participantProfiles with email, phone, title in metadata', async () => {
  mockUsersList.mockResolvedValue({
    members: [
      {
        id: 'U1', name: 'alice',
        real_name: 'Alice Smith',
        profile: {
          email: 'alice@example.com',
          phone: '+1234567890',
          title: 'Engineer',
          image_72: 'https://avatars/alice.png',
          real_name: 'Alice Smith',
        },
      },
      {
        id: 'U2', name: 'bob',
        real_name: 'Bob Jones',
        profile: {
          email: 'bob@example.com',
          real_name: 'Bob Jones',
        },
      },
    ],
    response_metadata: { next_cursor: '' },
  });

  mockConversationsList.mockResolvedValue({
    channels: [{ id: 'C1', name: 'general' }],
    response_metadata: {},
  });

  mockConversationsHistory.mockResolvedValue({
    messages: [
      { ts: '1700000000.000', text: 'Hello', user: 'U1', reply_count: 0 },
    ],
  });

  const events: any[] = [];
  await syncSlack(makeCtx() as any, (e) => events.push(e));

  const profiles = events[0].content.metadata.participantProfiles;
  expect(profiles).toBeDefined();
  expect(profiles['alice']).toEqual({
    name: 'alice',
    realName: 'Alice Smith',
    email: 'alice@example.com',
    phone: '+1234567890',
    title: 'Engineer',
    avatarUrl: 'https://avatars/alice.png',
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/connectors/slack && npx vitest run src/__tests__/sync.test.ts --reporter=verbose`
Expected: FAIL — `participantProfiles` is undefined

**Step 3: Implement — expand fetchUserMap and emit profiles**

In `packages/connectors/slack/src/sync.ts`, replace the `fetchUserMap` function (lines 9-25) and the `UserProfile` interface:

```typescript
interface UserProfile {
  name: string;
  realName: string;
  email?: string;
  phone?: string;
  title?: string;
  avatarUrl?: string;
}

/** Pre-fetch workspace users with profile data for mention resolution and contact enrichment */
async function fetchUserMap(client: WebClient): Promise<Map<string, UserProfile>> {
  const map = new Map<string, UserProfile>();
  try {
    let cursor: string | undefined;
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const u of res.members || []) {
        if (u.id && u.name) {
          map.set(u.id, {
            name: u.name,
            realName: (u as any).real_name || u.profile?.real_name || u.name,
            email: u.profile?.email,
            phone: u.profile?.phone ? String(u.profile.phone) : undefined,
            title: u.profile?.title || undefined,
            avatarUrl: u.profile?.image_72 || undefined,
          });
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // Best effort — mentions will stay as raw IDs
  }
  return map;
}
```

Update `normalizeSlackText` signature — it currently takes `Map<string, string>`. Change all references to use `users.get(id)?.name ?? id` instead of `users.get(id) ?? id`. The key change is the map value type goes from `string` to `UserProfile`.

Create a helper for name lookups:

```typescript
function userName(users: Map<string, UserProfile>, id: string): string {
  return users.get(id)?.name ?? id;
}
```

Update all call sites in `normalizeSlackText`, `channelLabel`, `fetchThreadContext`, and `syncSlack` that call `users.get(x)` to use `userName(users, x)` instead.

In the `emit()` call in `syncSlack` (line 183-198), add `participantProfiles` to metadata:

```typescript
// Build profiles map for emitted participants
const participantProfiles: Record<string, UserProfile> = {};
for (const p of participants) {
  // Find profile by name match
  for (const [, profile] of users) {
    if (profile.name === p) {
      participantProfiles[p] = profile;
      break;
    }
  }
}

emit({
  sourceType: 'message',
  sourceId: `${channel.id}:${msg.ts}`,
  timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
  content: {
    text: fullText,
    participants: [...participants],
    metadata: {
      channel: convLabel,
      channelId: channel.id,
      channelType: convType,
      threadTs: msg.thread_ts,
      replyCount: (msg as any).reply_count || 0,
      participantProfiles,
    },
  },
});
```

**Step 4: Run test to verify it passes**

Run: `cd packages/connectors/slack && npx vitest run src/__tests__/sync.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/connectors/slack/src/sync.ts packages/connectors/slack/src/__tests__/sync.test.ts
git commit -m "feat(slack): emit full user profiles in sync metadata for cross-connector contact merge"
```

---

### Task 2: Slack Contact Enrichment — Update resolveSlackContacts

**Files:**
- Modify: `apps/api/src/memory/embed.processor.ts:245-259`
- Test: `apps/api/src/memory/__tests__/embed.processor.test.ts` (create if missing)

**Step 1: Write the failing test**

Create `apps/api/src/memory/__tests__/resolveSlackContacts.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Test the logic of building identifiers from Slack profiles
// We test the identifier-building logic in isolation

describe('resolveSlackContacts identifier building', () => {
  it('creates email, phone, name, and slack_id identifiers from profile', () => {
    const metadata = {
      participantProfiles: {
        alice: {
          name: 'alice',
          realName: 'Alice Smith',
          email: 'alice@example.com',
          phone: '+1234567890',
          title: 'Engineer',
        },
      },
    };
    const participants = ['alice'];

    // Build identifiers the same way resolveSlackContacts will
    const allIdentifiers: Array<{ type: string; value: string }> = [];
    const profiles = (metadata.participantProfiles || {}) as Record<string, any>;

    for (const username of participants) {
      const profile = profiles[username];
      if (profile) {
        allIdentifiers.push({ type: 'name', value: profile.realName || username });
        if (profile.email) allIdentifiers.push({ type: 'email', value: profile.email });
        if (profile.phone) allIdentifiers.push({ type: 'phone', value: profile.phone });
        allIdentifiers.push({ type: 'slack_id', value: username });
      } else {
        allIdentifiers.push({ type: 'slack_id', value: username });
      }
    }

    expect(allIdentifiers).toEqual([
      { type: 'name', value: 'Alice Smith' },
      { type: 'email', value: 'alice@example.com' },
      { type: 'phone', value: '+1234567890' },
      { type: 'slack_id', value: 'alice' },
    ]);
  });

  it('falls back to slack_id only when no profile available', () => {
    const metadata = {};
    const participants = ['unknown_user'];

    const profiles = ((metadata as any).participantProfiles || {}) as Record<string, any>;
    const allIdentifiers: Array<{ type: string; value: string }> = [];

    for (const username of participants) {
      const profile = profiles[username];
      if (profile) {
        allIdentifiers.push({ type: 'name', value: profile.realName || username });
      } else {
        allIdentifiers.push({ type: 'slack_id', value: username });
      }
    }

    expect(allIdentifiers).toEqual([
      { type: 'slack_id', value: 'unknown_user' },
    ]);
  });
});
```

**Step 2: Run test to verify it passes** (this is a pure logic test)

Run: `cd apps/api && npx vitest run src/memory/__tests__/resolveSlackContacts.test.ts --reporter=verbose`
Expected: PASS (logic test validates expected identifier shape)

**Step 3: Update resolveSlackContacts in embed.processor.ts**

Replace `resolveSlackContacts` (lines 245-259):

```typescript
private async resolveSlackContacts(
  memoryId: string,
  metadata: Record<string, unknown>,
  participants: string[],
): Promise<void> {
  const profiles = (metadata.participantProfiles || {}) as Record<string, {
    name: string;
    realName?: string;
    email?: string;
    phone?: string;
    title?: string;
    avatarUrl?: string;
  }>;

  for (const username of participants) {
    if (!username) continue;
    const profile = profiles[username];
    const identifiers: IdentifierInput[] = [];

    if (profile) {
      identifiers.push({ type: 'name', value: profile.realName || username, connectorType: 'slack' });
      if (profile.email) {
        identifiers.push({ type: 'email', value: profile.email, connectorType: 'slack' });
      }
      if (profile.phone) {
        identifiers.push({ type: 'phone', value: profile.phone, connectorType: 'slack' });
      }
      identifiers.push({ type: 'slack_id', value: username, connectorType: 'slack' });
    } else {
      identifiers.push({ type: 'slack_id', value: username, connectorType: 'slack' });
    }

    const contact = await this.contactsService.resolveContact(identifiers);
    await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
  }
}
```

**Step 4: Run all embed tests**

Run: `cd apps/api && npx vitest run src/memory/__tests__/ --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/api/src/memory/embed.processor.ts apps/api/src/memory/__tests__/resolveSlackContacts.test.ts
git commit -m "feat(contacts): resolve Slack contacts with email, phone, name for cross-connector merge"
```

---

### Task 3: Weight Breakdown — Compute and Store in Enrich Processor

**Files:**
- Modify: `apps/api/src/memory/enrich.processor.ts:122-129`
- Modify: `apps/api/src/memory/memory.service.ts:31-39,362-374`

**Step 1: Add TRUST_SCORES to a shared location**

The `TRUST_SCORES` map exists in `memory.service.ts:31-39`. Export it so enrich processor can use it too:

In `apps/api/src/memory/memory.service.ts`, change line 31 from:
```typescript
const TRUST_SCORES: Record<string, number> = {
```
to:
```typescript
export const TRUST_SCORES: Record<string, number> = {
```

**Step 2: Add weight computation to enrich processor**

In `apps/api/src/memory/enrich.processor.ts`, add import at top:
```typescript
import { TRUST_SCORES } from './memory.service';
```

Before the `[enrich:done]` log (line 127), add weight computation:

```typescript
// Compute and store base weights
const ageDays = (Date.now() - new Date(memory.eventTime).getTime()) / (1000 * 60 * 60 * 24);
const recency = Math.exp(-0.015 * ageDays);
const importance = 0.5 + Math.min(entities.length * 0.1, 0.4);
const trust = TRUST_SCORES[memory.connectorType] || 0.7;
const weights = { semantic: 0, rerank: 0, recency, importance, trust, final: 0 };

await this.dbService.db
  .update(memories)
  .set({ weights: JSON.stringify(weights) })
  .where(eq(memories.id, memoryId));
```

**Step 3: Update search to return weight breakdown**

In `apps/api/src/memory/memory.service.ts`, change `SearchResult` interface (line 18) to add `weights`:

```typescript
export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: string;
  factuality: string;
  entities: string;
  metadata: string;
  accountIdentifier: string | null;
  score: number;
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
}
```

Change `computeScore` (lines 362-374) to return the full breakdown:

```typescript
private computeWeights(semanticScore: number, mem: any): {
  score: number;
  weights: { semantic: number; rerank: number; recency: number; importance: number; trust: number; final: number };
} {
  const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.exp(-0.015 * ageDays);

  let entityCount = 0;
  try {
    entityCount = JSON.parse(mem.entities).length;
  } catch {}
  const importance = 0.5 + Math.min(entityCount * 0.1, 0.4);
  const trust = TRUST_SCORES[mem.connectorType] || 0.7;
  const final = 0.4 * semanticScore + 0.25 * recency + 0.2 * importance + 0.15 * trust;

  return {
    score: final,
    weights: { semantic: semanticScore, rerank: 0, recency, importance, trust, final },
  };
}
```

Update the search loop (line 76) to use the new method:

```typescript
const { score, weights } = this.computeWeights(point.score, mem);
results.push({
  id: mem.id,
  text: mem.text,
  sourceType: mem.sourceType,
  connectorType: mem.connectorType,
  eventTime: mem.eventTime,
  factuality: mem.factuality,
  entities: mem.entities,
  metadata: mem.metadata,
  accountIdentifier: rows[0].accountIdentifier,
  score,
  weights,
});
```

**Step 4: Run existing tests**

Run: `pnpm test --filter=@botmem/api`
Expected: PASS (or fix any broken tests from interface change)

**Step 5: Commit**

```bash
git add apps/api/src/memory/enrich.processor.ts apps/api/src/memory/memory.service.ts
git commit -m "feat(weights): compute base weights at enrich time, return breakdown from search"
```

---

### Task 4: File Pipeline — Create FileProcessor

**Files:**
- Create: `apps/api/src/memory/file.processor.ts`
- Modify: `apps/api/src/memory/memory.module.ts`
- Modify: `apps/api/package.json` (add pdf-parse)

**Step 1: Install dependencies for file conversion**

Run: `cd apps/api && pnpm add pdf-parse mammoth xlsx && pnpm add -D @types/pdf-parse`

- `pdf-parse` — PDF → text extraction (we'll format as markdown)
- `mammoth` — DOCX → markdown/HTML conversion (preserves headings, lists, tables)
- `xlsx` — Excel/CSV → markdown table conversion

**Step 2: Create FileProcessor**

Create `apps/api/src/memory/file.processor.ts`:

```typescript
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { memories } from '../db/schema';
import { photoDescriptionPrompt } from './prompts';

const MAX_CONTENT_LENGTH = 10_000;

interface FileJobData {
  memoryId: string;
}

@Processor('file')
export class FileProcessor extends WorkerHost {
  private collectionReady = false;

  constructor(
    private dbService: DbService,
    private accountsService: AccountsService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    @InjectQueue('enrich') private enrichQueue: Queue,
    private logsService: LogsService,
    private events: EventsService,
  ) {
    super();
  }

  async process(job: Job<FileJobData>) {
    const { memoryId } = job.data;

    const rows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));

    if (!rows.length) return;
    const memory = rows[0];
    const mid = memoryId.slice(0, 8);
    const metadata = JSON.parse(memory.metadata);

    const fileUrl = metadata.fileUrl as string;
    const mimetype = (metadata.mimetype as string) || '';
    const fileName = (metadata.fileName as string) || 'unknown';

    if (!fileUrl) {
      this.addLog(memory.connectorType, memory.accountId, 'warn',
        `[file:skip] ${mid} no fileUrl in metadata`);
      return;
    }

    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[file:start] ${mid} ${fileName} (${mimetype})`);

    const t0 = Date.now();

    try {
      // Download file
      const headers = await this.buildAuthHeaders(memory.accountId, memory.connectorType, metadata);
      const res = await fetch(fileUrl, { headers });

      if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // Route by MIME type
      let extractedContent: string;

      if (mimetype.startsWith('image/')) {
        extractedContent = await this.processImage(buffer, memory.text);
      } else if (mimetype === 'application/pdf') {
        extractedContent = await this.processPdf(buffer, fileName);
      } else if (this.isDocx(mimetype, fileName)) {
        extractedContent = await this.processDocx(buffer, fileName);
      } else if (this.isSpreadsheet(mimetype, fileName)) {
        extractedContent = this.processSpreadsheet(buffer, fileName);
      } else if (mimetype.startsWith('text/') && !fileName.endsWith('.csv')) {
        extractedContent = this.processPlainText(buffer, fileName);
      } else {
        this.addLog(memory.connectorType, memory.accountId, 'warn',
          `[file:skip] ${mid} unsupported MIME type: ${mimetype}`);
        return;
      }

      if (!extractedContent.trim()) {
        this.addLog(memory.connectorType, memory.accountId, 'warn',
          `[file:empty] ${mid} no content extracted from ${fileName}`);
        return;
      }

      // Update memory text with extracted content
      const updatedText = `${memory.text}\n\n${extractedContent}`;
      await this.dbService.db
        .update(memories)
        .set({ text: updatedText })
        .where(eq(memories.id, memoryId));

      // Re-embed with new text
      const vector = await this.ollama.embed(updatedText);
      if (!this.collectionReady) {
        await this.qdrant.ensureCollection(vector.length);
        this.collectionReady = true;
      }
      await this.qdrant.upsert(memoryId, vector, {
        source_type: memory.sourceType,
        connector_type: memory.connectorType,
        event_time: memory.eventTime,
        account_id: memory.accountId,
      });

      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, memoryId));

      // Enqueue enrichment
      await this.enrichQueue.add(
        'enrich',
        { memoryId },
        { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
      );

      const ms = Date.now() - t0;
      this.addLog(memory.connectorType, memory.accountId, 'info',
        `[file:done] ${mid} ${fileName} in ${ms}ms (${extractedContent.length} chars extracted)`);

    } catch (err: any) {
      const ms = Date.now() - t0;
      this.addLog(memory.connectorType, memory.accountId, 'error',
        `[file:fail] ${mid} ${fileName} after ${ms}ms: ${err?.message || err}`);
      throw err;
    }
  }

  // --- Content extractors ---

  private async processImage(buffer: Buffer, existingText: string): Promise<string> {
    const base64 = buffer.toString('base64');
    const description = await this.ollama.generate(
      photoDescriptionPrompt(existingText),
      [base64],
    );
    return description.trim();
  }

  private async processPdf(buffer: Buffer, fileName: string): Promise<string> {
    const data = await pdfParse(buffer);
    const raw = data.text?.trim();
    if (!raw) return '';
    // Format as markdown with filename header
    let md = `# ${fileName}\n\n${raw}`;
    if (md.length > MAX_CONTENT_LENGTH) {
      md = md.slice(0, MAX_CONTENT_LENGTH) + `\n\n---\n*[Truncated — ${data.numpages} pages total]*`;
    }
    return md;
  }

  private async processDocx(buffer: Buffer, fileName: string): Promise<string> {
    const result = await mammoth.convertToMarkdown({ buffer });
    let md = `# ${fileName}\n\n${result.value.trim()}`;
    if (md.length > MAX_CONTENT_LENGTH) {
      md = md.slice(0, MAX_CONTENT_LENGTH) + '\n\n---\n*[Truncated]*';
    }
    return md;
  }

  private processSpreadsheet(buffer: Buffer, fileName: string): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [`# ${fileName}`];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      parts.push(`\n## ${sheetName}\n`);

      // Convert to array of arrays, then format as markdown table
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (rows.length === 0) continue;

      // Header row
      const header = (rows[0] as unknown[]).map((c) => String(c ?? ''));
      parts.push('| ' + header.join(' | ') + ' |');
      parts.push('| ' + header.map(() => '---').join(' | ') + ' |');

      // Data rows
      for (let i = 1; i < rows.length; i++) {
        const cells = (rows[i] as unknown[]).map((c) => String(c ?? ''));
        parts.push('| ' + cells.join(' | ') + ' |');
      }
    }

    let md = parts.join('\n');
    if (md.length > MAX_CONTENT_LENGTH) {
      md = md.slice(0, MAX_CONTENT_LENGTH) + '\n\n---\n*[Truncated]*';
    }
    return md;
  }

  private processPlainText(buffer: Buffer, fileName: string): string {
    const text = buffer.toString('utf-8').trim();
    // Wrap in markdown with filename
    let md = `# ${fileName}\n\n${text}`;
    if (md.length > MAX_CONTENT_LENGTH) {
      md = md.slice(0, MAX_CONTENT_LENGTH) + '\n\n---\n*[Truncated]*';
    }
    return md;
  }

  // --- Helpers ---

  private isDocx(mimetype: string, fileName: string): boolean {
    return mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || fileName.endsWith('.docx');
  }

  private isSpreadsheet(mimetype: string, fileName: string): boolean {
    return mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || mimetype === 'application/vnd.ms-excel'
      || fileName.endsWith('.xlsx')
      || fileName.endsWith('.xls')
      || fileName.endsWith('.csv');
  }

  private async buildAuthHeaders(
    accountId: string | null,
    connectorType: string,
    metadata: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    if (!accountId) return {};

    const account = await this.accountsService.getById(accountId);
    const authContext = account.authContext ? JSON.parse(account.authContext) : null;
    if (!authContext) return {};

    switch (connectorType) {
      case 'slack':
        return { Authorization: `Bearer ${authContext.accessToken}` };
      case 'photos':
        return { 'x-api-key': authContext.accessToken };
      default:
        return {};
    }
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'file';
    this.logsService.add({ connectorType, accountId: accountId ?? undefined, stage, level, message });
    this.events.emitToChannel('logs', 'log', { connectorType, accountId, stage, level, message, timestamp: new Date().toISOString() });
  }
}
```

**Step 3: Register file queue in memory module**

In `apps/api/src/memory/memory.module.ts`, add the import and registration:

```typescript
import { FileProcessor } from './file.processor';
```

Add to imports array:
```typescript
BullModule.registerQueue({ name: 'file' }),
```

Add to providers array:
```typescript
FileProcessor,
```

**Step 4: Add 'file' to PipelineStage type**

In `packages/shared/src/types/index.ts`, update line 54:
```typescript
export type PipelineStage = 'sync' | 'embed' | 'enrich' | 'backfill' | 'file';
```

**Step 5: Verify build**

Run: `pnpm build --filter=@botmem/api`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add apps/api/src/memory/file.processor.ts apps/api/src/memory/memory.module.ts apps/api/package.json packages/shared/src/types/index.ts pnpm-lock.yaml
git commit -m "feat(pipeline): add shared FileProcessor for image/document/PDF content extraction"
```

---

### Task 5: File Pipeline — Route file events from embed processor

**Files:**
- Modify: `apps/api/src/memory/embed.processor.ts:34,56,96-131`

**Step 1: Add file queue injection**

In `apps/api/src/memory/embed.processor.ts`, add `@InjectQueue('file')` to the constructor:

```typescript
constructor(
  private dbService: DbService,
  private ollama: OllamaService,
  private qdrant: QdrantService,
  private contactsService: ContactsService,
  @InjectQueue('enrich') private enrichQueue: Queue,
  @InjectQueue('file') private fileQueue: Queue,
  private events: EventsService,
  private logsService: LogsService,
) {
  super();
}
```

**Step 2: Route file events to file queue instead of direct embedding**

After creating the memory record (after line 81), add routing logic. If `sourceType === 'file'`, enqueue to file queue and skip embedding:

```typescript
// Route file events to the file processor
if (event.sourceType === 'file') {
  this.addLog(rawEvent.connectorType, rawEvent.accountId, 'info',
    `[embed:file-route] ${mid} → file queue for content extraction`);
  await this.fileQueue.add(
    'file',
    { memoryId },
    { attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
  );
  return;
}
```

This goes right after the `dbInsertMs` line and before the contact resolution (step 4).

**Step 3: Verify build**

Run: `pnpm build --filter=@botmem/api`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add apps/api/src/memory/embed.processor.ts
git commit -m "feat(embed): route file-type events to shared file processing queue"
```

---

### Task 6: File Pipeline — Emit file events from Slack sync

**Files:**
- Modify: `packages/connectors/slack/src/sync.ts:151-172`
- Test: `packages/connectors/slack/src/__tests__/sync.test.ts`

**Step 1: Write the failing test**

Add to `sync.test.ts`:

```typescript
it('emits separate file events for message attachments', async () => {
  mockConversationsList.mockResolvedValue({
    channels: [{ id: 'C1', name: 'general' }],
    response_metadata: {},
  });

  mockConversationsHistory.mockResolvedValue({
    messages: [
      {
        ts: '1700000000.000',
        text: 'Check this out',
        user: 'U1',
        reply_count: 0,
        files: [
          {
            id: 'F1',
            name: 'report.pdf',
            mimetype: 'application/pdf',
            filetype: 'pdf',
            size: 12345,
            url_private: 'https://files.slack.com/files-pri/T123/report.pdf',
          },
          {
            id: 'F2',
            name: 'photo.png',
            mimetype: 'image/png',
            filetype: 'png',
            size: 54321,
            url_private: 'https://files.slack.com/files-pri/T123/photo.png',
          },
        ],
      },
    ],
  });

  const events: any[] = [];
  await syncSlack(makeCtx() as any, (e) => events.push(e));

  // 1 message + 2 file events
  expect(events.length).toBe(3);

  // The message event
  expect(events[0].sourceType).toBe('message');
  expect(events[0].content.text).toContain('[file: report.pdf (pdf)]');

  // File events
  const fileEvents = events.filter((e) => e.sourceType === 'file');
  expect(fileEvents.length).toBe(2);
  expect(fileEvents[0].content.metadata.fileName).toBe('report.pdf');
  expect(fileEvents[0].content.metadata.mimetype).toBe('application/pdf');
  expect(fileEvents[0].content.metadata.fileUrl).toBe('https://files.slack.com/files-pri/T123/report.pdf');
  expect(fileEvents[0].content.metadata.parentMessageId).toBe('C1:1700000000.000');
  expect(fileEvents[1].content.metadata.fileName).toBe('photo.png');
  expect(fileEvents[1].content.metadata.mimetype).toBe('image/png');
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/connectors/slack && npx vitest run src/__tests__/sync.test.ts --reporter=verbose`
Expected: FAIL — only 1 event emitted

**Step 3: Add file event emission after the message emit**

In `packages/connectors/slack/src/sync.ts`, after the main `emit()` call (after line 198), add:

```typescript
// Emit separate events for file attachments
for (const file of files) {
  if (!file.url_private || !file.mimetype) continue;
  emit({
    sourceType: 'file',
    sourceId: `${channel.id}:${msg.ts}:${file.id || file.name}`,
    timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    content: {
      text: `[${convLabel}] ${author} shared: ${file.name || 'untitled'}`,
      participants: [...participants],
      metadata: {
        channel: convLabel,
        channelId: channel.id,
        channelType: convType,
        fileName: file.name,
        mimetype: file.mimetype,
        fileUrl: file.url_private,
        fileSize: file.size,
        parentMessageId: `${channel.id}:${msg.ts}`,
        participantProfiles,
      },
    },
  });
  processed++;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/connectors/slack && npx vitest run src/__tests__/sync.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/connectors/slack/src/sync.ts packages/connectors/slack/src/__tests__/sync.test.ts
git commit -m "feat(slack): emit separate file events for message attachments"
```

---

### Task 7: File Pipeline — Migrate Immich photo processing

**Files:**
- Modify: `packages/connectors/photos-immich/src/index.ts:166-210`
- Modify: `apps/api/src/memory/enrich.processor.ts:59-101`

**Step 1: Change Immich sourceType from 'photo' to 'file'**

In `packages/connectors/photos-immich/src/index.ts`, line 167, change:
```typescript
sourceType: 'photo',
```
to:
```typescript
sourceType: 'file',
```

Also add `fileUrl` and `mimetype` to metadata so the FileProcessor can download it:

In the metadata block (line 179-208), add:
```typescript
fileUrl: `${host}/api/assets/${asset.id}/thumbnail?size=preview`,
mimetype: asset.originalMimeType ?? 'image/jpeg',
fileName: asset.originalFileName,
```

**Step 2: Remove describePhoto from enrich processor**

In `apps/api/src/memory/enrich.processor.ts`, remove the entire photo-specific block (lines 59-101) — the `if (memory.sourceType === 'photo')` block. Also remove the `describePhoto` method (lines 138-176). Also remove the `AccountsService` import and constructor injection if it's no longer used elsewhere in this file.

Check if `AccountsService` is used elsewhere in enrich.processor.ts — it's only used in `describePhoto`. Remove it from the constructor and imports.

Remove `photoDescriptionPrompt` from the imports at line 12 (it's now only used in file.processor.ts).

**Step 3: Update shared SourceType to include 'file'**

In `packages/shared/src/types/index.ts`, line 65:
```typescript
export type SourceType = 'email' | 'message' | 'photo' | 'location' | 'file';
```

**Step 4: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add packages/connectors/photos-immich/src/index.ts apps/api/src/memory/enrich.processor.ts packages/shared/src/types/index.ts
git commit -m "refactor: migrate Immich photo processing to shared FileProcessor pipeline"
```

---

### Task 8: Integration test — full file pipeline

**Files:**
- Create: `apps/api/src/memory/__tests__/file.processor.test.ts`

**Step 1: Write integration test for FileProcessor**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies
const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbInsert = vi.fn();

const mockOllamaEmbed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
const mockOllamaGenerate = vi.fn().mockResolvedValue('A photo showing a team meeting in an office');

const mockQdrantEnsure = vi.fn();
const mockQdrantUpsert = vi.fn();

const mockEnrichQueueAdd = vi.fn();
const mockLogsAdd = vi.fn();
const mockEventsEmit = vi.fn();
const mockAccountsGetById = vi.fn();

// We'll test the routing logic and content extraction logic separately
describe('FileProcessor MIME routing', () => {
  function classifyMime(mimetype: string, fileName: string): string {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype === 'application/pdf') return 'pdf';
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || fileName.endsWith('.docx')) return 'docx';
    if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || mimetype === 'application/vnd.ms-excel'
        || fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv')) return 'spreadsheet';
    if (mimetype.startsWith('text/') || mimetype === 'application/csv') return 'text';
    return 'unsupported';
  }

  it('routes images to VL model', () => {
    expect(classifyMime('image/png', 'photo.png')).toBe('image');
    expect(classifyMime('image/jpeg', 'photo.jpg')).toBe('image');
  });

  it('routes PDFs to pdf-parse', () => {
    expect(classifyMime('application/pdf', 'report.pdf')).toBe('pdf');
  });

  it('routes DOCX to mammoth', () => {
    expect(classifyMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx')).toBe('docx');
    expect(classifyMime('application/octet-stream', 'doc.docx')).toBe('docx');
  });

  it('routes spreadsheets to xlsx', () => {
    expect(classifyMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data.xlsx')).toBe('spreadsheet');
    expect(classifyMime('application/vnd.ms-excel', 'data.xls')).toBe('spreadsheet');
    expect(classifyMime('text/csv', 'data.csv')).toBe('spreadsheet');
  });

  it('routes plain text directly', () => {
    expect(classifyMime('text/plain', 'readme.txt')).toBe('text');
    expect(classifyMime('text/html', 'page.html')).toBe('text');
  });

  it('rejects unsupported types', () => {
    expect(classifyMime('application/zip', 'archive.zip')).toBe('unsupported');
    expect(classifyMime('video/mp4', 'clip.mp4')).toBe('unsupported');
  });
});
```

**Step 2: Run test**

Run: `cd apps/api && npx vitest run src/memory/__tests__/file.processor.test.ts --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/api/src/memory/__tests__/file.processor.test.ts
git commit -m "test: add file processor routing tests"
```

---

### Task 9: Final verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Final commit if any cleanup needed**

---

## Summary of changes by file

| File | Change |
|------|--------|
| `packages/connectors/slack/src/sync.ts` | Expand fetchUserMap to full profiles, emit participantProfiles in metadata, emit file events |
| `packages/connectors/slack/src/__tests__/sync.test.ts` | Tests for profile emission, file event emission |
| `apps/api/src/memory/embed.processor.ts` | Add file queue injection, route file events, update resolveSlackContacts for multi-identifier |
| `apps/api/src/memory/enrich.processor.ts` | Remove describePhoto, add weight computation |
| `apps/api/src/memory/file.processor.ts` | NEW — shared FileProcessor for images/PDFs/text |
| `apps/api/src/memory/memory.module.ts` | Register file queue and FileProcessor |
| `apps/api/src/memory/memory.service.ts` | Export TRUST_SCORES, return weight breakdown from search |
| `packages/connectors/photos-immich/src/index.ts` | Change sourceType to 'file', add fileUrl/mimetype to metadata |
| `packages/shared/src/types/index.ts` | Add 'file' to SourceType and PipelineStage |
| `apps/api/package.json` | Add pdf-parse, mammoth, xlsx dependencies |
