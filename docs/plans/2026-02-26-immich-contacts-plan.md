# Immich Connector Fixes + Contacts Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Immich photo→contact linking, add avatar storage, build a full contacts management page with merge suggestions.

**Architecture:** Backend-first — fix the embed processor contact bypass, migrate schema (avatarUrl→avatars, add mergeDismissals), extend ContactsService with update/merge/suggestions/delete, then build the frontend contacts page with Zustand store, neobrutal UI, and detail panel.

**Tech Stack:** NestJS 11, Drizzle ORM + SQLite, React 19, Zustand 5, Tailwind 4 (neobrutal design system), Vitest

---

### Task 1: Schema Migration — avatarUrl → avatars + mergeDismissals table

**Files:**
- Modify: `apps/api/src/db/schema.ts:93-100`
- Modify: `apps/api/src/db/db.service.ts:113-143`

**Step 1: Update Drizzle schema**

In `apps/api/src/db/schema.ts`, replace the `contacts` table definition:

```ts
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  avatars: text('avatars').notNull().default('[]'), // JSON array of {url, source}
  metadata: text('metadata').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

Add `mergeDismissals` table after `memoryContacts`:

```ts
export const mergeDismissals = sqliteTable('merge_dismissals', {
  id: text('id').primaryKey(),
  contactId1: text('contact_id_1').notNull().references(() => contacts.id),
  contactId2: text('contact_id_2').notNull().references(() => contacts.id),
  createdAt: text('created_at').notNull(),
});
```

**Step 2: Update DbService.createTables()**

In `apps/api/src/db/db.service.ts`, change the `contacts` CREATE TABLE to use `avatars` instead of `avatar_url`:

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatars TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add the `merge_dismissals` table creation:

```sql
CREATE TABLE IF NOT EXISTS merge_dismissals (
  id TEXT PRIMARY KEY,
  contact_id_1 TEXT NOT NULL REFERENCES contacts(id),
  contact_id_2 TEXT NOT NULL REFERENCES contacts(id),
  created_at TEXT NOT NULL
);
```

Add a migration for existing databases (after the existing `ALTER TABLE logs` migration):

```ts
try {
  this.sqlite.exec(`ALTER TABLE contacts ADD COLUMN avatars TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // Column already exists
}
// Migrate existing avatar_url values
try {
  this.sqlite.exec(`
    UPDATE contacts SET avatars = json_array(json_object('url', avatar_url, 'source', 'unknown'))
    WHERE avatar_url IS NOT NULL AND avatar_url != '' AND avatars = '[]'
  `);
} catch {
  // Migration already applied or avatar_url doesn't exist
}
```

**Step 3: Verify build compiles**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Expected: Build succeeds (schema changes only affect types).

**Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/db.service.ts
git commit -m "feat: migrate contacts avatarUrl to avatars JSON array, add mergeDismissals table"
```

---

### Task 2: ContactsService — Update, Merge, Suggestions, Delete

**Files:**
- Modify: `apps/api/src/contacts/contacts.service.ts`
- Modify: `apps/api/src/contacts/__tests__/contacts.service.test.ts`

**Step 1: Write failing tests for new methods**

Add these tests to `apps/api/src/contacts/__tests__/contacts.service.test.ts`:

```ts
describe('updateContact', () => {
  it('updates displayName', async () => {
    const contact = await service.resolveContact([
      { type: 'email', value: 'upd@test.com', connectorType: 'gmail' },
    ]);
    const updated = await service.updateContact(contact.id, { displayName: 'New Name' });
    expect(updated!.displayName).toBe('New Name');
  });

  it('appends avatar without duplicating', async () => {
    const contact = await service.resolveContact([
      { type: 'email', value: 'av@test.com', connectorType: 'gmail' },
    ]);
    await service.updateContact(contact.id, {
      avatars: [{ url: 'data:image/jpeg;base64,abc', source: 'immich' }],
    });
    const updated = await service.updateContact(contact.id, {
      avatars: [
        { url: 'data:image/jpeg;base64,abc', source: 'immich' },
        { url: 'data:image/jpeg;base64,def', source: 'gmail' },
      ],
    });
    expect(JSON.parse(updated!.avatars)).toHaveLength(2);
  });

  it('returns null for non-existent contact', async () => {
    const result = await service.updateContact('nope', { displayName: 'x' });
    expect(result).toBeNull();
  });
});

describe('mergeContacts', () => {
  it('moves identifiers and memory links from source to target', async () => {
    const c1 = await service.resolveContact([
      { type: 'email', value: 'merge-a@test.com', connectorType: 'gmail' },
    ]);
    const c2 = await service.resolveContact([
      { type: 'phone', value: '+11234567890', connectorType: 'whatsapp' },
    ]);

    // Link a memory to c2
    const now = new Date().toISOString();
    await db.insert(memories).values({
      id: 'mem-merge-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-merge-1',
      text: 'test',
      eventTime: now,
      ingestTime: now,
      createdAt: now,
    });
    await service.linkMemory('mem-merge-1', c2.id, 'sender');

    const merged = await service.mergeContacts(c1.id, c2.id);
    expect(merged.id).toBe(c1.id);
    expect(merged.identifiers.length).toBeGreaterThanOrEqual(2);

    // c2 should be gone
    const gone = await service.getById(c2.id);
    expect(gone).toBeNull();

    // Memory link should now point to c1
    const links = await db.select().from(memoryContacts).where(eq(memoryContacts.memoryId, 'mem-merge-1'));
    expect(links[0].contactId).toBe(c1.id);
  });

  it('keeps the longer displayName', async () => {
    const c1 = await service.resolveContact([
      { type: 'name', value: 'Jo', connectorType: 'gmail' },
    ]);
    const c2 = await service.resolveContact([
      { type: 'name', value: 'Jonathan Smith', connectorType: 'slack' },
      { type: 'email', value: 'unique-merge@test.com', connectorType: 'slack' },
    ]);
    const merged = await service.mergeContacts(c1.id, c2.id);
    expect(merged.displayName).toBe('Jonathan Smith');
  });
});

describe('deleteContact', () => {
  it('removes contact, identifiers, and memory links', async () => {
    const contact = await service.resolveContact([
      { type: 'email', value: 'del@test.com', connectorType: 'gmail' },
    ]);
    const now = new Date().toISOString();
    await db.insert(memories).values({
      id: 'mem-del-1',
      accountId: 'acc-1',
      connectorType: 'gmail',
      sourceType: 'email',
      sourceId: 'src-del-1',
      text: 'test',
      eventTime: now,
      ingestTime: now,
      createdAt: now,
    });
    await service.linkMemory('mem-del-1', contact.id, 'sender');

    await service.deleteContact(contact.id);

    expect(await service.getById(contact.id)).toBeNull();
    const links = await db.select().from(memoryContacts).where(eq(memoryContacts.contactId, contact.id));
    expect(links).toHaveLength(0);
    const idents = await db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, contact.id));
    expect(idents).toHaveLength(0);
  });
});

describe('getSuggestions', () => {
  it('suggests contacts with overlapping names from different connectors', async () => {
    await service.resolveContact([
      { type: 'name', value: 'Amr Essam', connectorType: 'gmail' },
      { type: 'email', value: 'amr-suggest@test.com', connectorType: 'gmail' },
    ]);
    await service.resolveContact([
      { type: 'name', value: 'Amr', connectorType: 'photos' },
      { type: 'immich_person_id', value: 'p-suggest', connectorType: 'photos' },
    ]);

    const suggestions = await service.getSuggestions();
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0].reason).toContain('amr');
  });

  it('does not suggest contacts from the same connector', async () => {
    await service.resolveContact([
      { type: 'name', value: 'Same Person', connectorType: 'gmail' },
      { type: 'email', value: 'same1@test.com', connectorType: 'gmail' },
    ]);
    await service.resolveContact([
      { type: 'name', value: 'Same', connectorType: 'gmail' },
      { type: 'email', value: 'same2@test.com', connectorType: 'gmail' },
    ]);

    const suggestions = await service.getSuggestions();
    expect(suggestions).toHaveLength(0);
  });

  it('excludes dismissed suggestions', async () => {
    const c1 = await service.resolveContact([
      { type: 'name', value: 'Dismiss Test', connectorType: 'gmail' },
      { type: 'email', value: 'dismiss1@test.com', connectorType: 'gmail' },
    ]);
    const c2 = await service.resolveContact([
      { type: 'name', value: 'Dismiss', connectorType: 'photos' },
      { type: 'immich_person_id', value: 'p-dismiss', connectorType: 'photos' },
    ]);

    await service.dismissSuggestion(c1.id, c2.id);

    const suggestions = await service.getSuggestions();
    const match = suggestions.find(
      (s) => (s.contact1.id === c1.id && s.contact2.id === c2.id) ||
             (s.contact1.id === c2.id && s.contact2.id === c1.id),
    );
    expect(match).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/amr/Projects/botmem && pnpm vitest run apps/api/src/contacts/__tests__/contacts.service.test.ts`
Expected: New tests fail (methods don't exist yet).

**Step 3: Implement new methods in ContactsService**

In `apps/api/src/contacts/contacts.service.ts`:

1. Update imports: add `mergeDismissals` from schema
2. Update `ContactWithIdentifiers` interface: change `avatarUrl: string | null` → `avatars: string`
3. Add `updateContact(id, updates)` method:

```ts
async updateContact(id: string, updates: {
  displayName?: string;
  avatars?: Array<{ url: string; source: string }>;
  metadata?: Record<string, unknown>;
}): Promise<ContactWithIdentifiers | null> {
  const db = this.dbService.db;
  const existing = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!existing.length) return null;

  const patch: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (updates.displayName !== undefined) patch.displayName = updates.displayName;
  if (updates.avatars !== undefined) patch.avatars = JSON.stringify(updates.avatars);
  if (updates.metadata !== undefined) patch.metadata = JSON.stringify(updates.metadata);

  await db.update(contacts).set(patch).where(eq(contacts.id, id));
  return this.getById(id);
}
```

4. Add `mergeContacts(targetId, sourceId)` method:

```ts
async mergeContacts(targetId: string, sourceId: string): Promise<ContactWithIdentifiers> {
  const db = this.dbService.db;
  const [target, source] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.id, targetId)),
    db.select().from(contacts).where(eq(contacts.id, sourceId)),
  ]);
  if (!target.length || !source.length) throw new Error('Contact not found');

  // Move identifiers
  await db.update(contactIdentifiers).set({ contactId: targetId }).where(eq(contactIdentifiers.contactId, sourceId));

  // Move memory links
  await db.update(memoryContacts).set({ contactId: targetId }).where(eq(memoryContacts.contactId, sourceId));

  // Merge avatars (target first, then source — dedup by url)
  const targetAvatars: Array<{ url: string; source: string }> = JSON.parse(target[0].avatars || '[]');
  const sourceAvatars: Array<{ url: string; source: string }> = JSON.parse(source[0].avatars || '[]');
  const existingUrls = new Set(targetAvatars.map((a) => a.url));
  for (const a of sourceAvatars) {
    if (!existingUrls.has(a.url)) targetAvatars.push(a);
  }

  // Keep longest displayName
  const displayName = source[0].displayName.length > target[0].displayName.length
    ? source[0].displayName : target[0].displayName;

  await db.update(contacts).set({
    displayName,
    avatars: JSON.stringify(targetAvatars),
    updatedAt: new Date().toISOString(),
  }).where(eq(contacts.id, targetId));

  // Delete source contact
  await db.delete(contacts).where(eq(contacts.id, sourceId));

  // Clean up any dismissals referencing the source
  await db.delete(mergeDismissals).where(
    sql`${mergeDismissals.contactId1} = ${sourceId} OR ${mergeDismissals.contactId2} = ${sourceId}`
  );

  return this.getById(targetId) as Promise<ContactWithIdentifiers>;
}
```

5. Add `deleteContact(id)` method:

```ts
async deleteContact(id: string): Promise<void> {
  const db = this.dbService.db;
  await db.delete(memoryContacts).where(eq(memoryContacts.contactId, id));
  await db.delete(contactIdentifiers).where(eq(contactIdentifiers.contactId, id));
  await db.delete(mergeDismissals).where(
    sql`${mergeDismissals.contactId1} = ${id} OR ${mergeDismissals.contactId2} = ${id}`
  );
  await db.delete(contacts).where(eq(contacts.id, id));
}
```

6. Add `getSuggestions()` method:

```ts
async getSuggestions(): Promise<Array<{
  contact1: ContactWithIdentifiers;
  contact2: ContactWithIdentifiers;
  reason: string;
}>> {
  const db = this.dbService.db;

  // Load all contacts with their identifiers
  const allContacts = await db.select().from(contacts);
  const allIdents = await db.select().from(contactIdentifiers);
  const dismissals = await db.select().from(mergeDismissals);

  // Build contact → connectors map
  const contactConnectors = new Map<string, Set<string>>();
  for (const ident of allIdents) {
    if (!ident.connectorType) continue;
    if (!contactConnectors.has(ident.contactId)) contactConnectors.set(ident.contactId, new Set());
    contactConnectors.get(ident.contactId)!.add(ident.connectorType);
  }

  // Build dismissed pairs set
  const dismissedPairs = new Set<string>();
  for (const d of dismissals) {
    const key = [d.contactId1, d.contactId2].sort().join('|');
    dismissedPairs.add(key);
  }

  const suggestions: Array<{ contact1: ContactWithIdentifiers; contact2: ContactWithIdentifiers; reason: string }> = [];

  for (let i = 0; i < allContacts.length; i++) {
    for (let j = i + 1; j < allContacts.length; j++) {
      const a = allContacts[i];
      const b = allContacts[j];

      // Check dismissed
      const pairKey = [a.id, b.id].sort().join('|');
      if (dismissedPairs.has(pairKey)) continue;

      // Must be from different connectors
      const aConns = contactConnectors.get(a.id) || new Set();
      const bConns = contactConnectors.get(b.id) || new Set();
      const hasOverlap = [...aConns].some((c) => bConns.has(c));
      if (hasOverlap && aConns.size === 1 && bConns.size === 1) continue; // Same single connector

      const nameA = a.displayName.toLowerCase().trim();
      const nameB = b.displayName.toLowerCase().trim();
      if (!nameA || !nameB) continue;

      if (nameA.includes(nameB) || nameB.includes(nameA)) {
        const shorter = nameA.length <= nameB.length ? nameA : nameB;
        const longer = nameA.length > nameB.length ? nameA : nameB;
        const aFull = await this.getById(a.id);
        const bFull = await this.getById(b.id);
        if (aFull && bFull) {
          suggestions.push({
            contact1: aFull,
            contact2: bFull,
            reason: `Name overlap: '${shorter}' ⊂ '${longer}'`,
          });
        }
      }
    }
  }

  return suggestions;
}
```

7. Add `dismissSuggestion(contactId1, contactId2)` method:

```ts
async dismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
  const [id1, id2] = [contactId1, contactId2].sort();
  await this.dbService.db.insert(mergeDismissals).values({
    id: randomUUID(),
    contactId1: id1,
    contactId2: id2,
    createdAt: new Date().toISOString(),
  });
}
```

8. Fix the N+1 in `list()` — replace the per-contact identifier query with a single batch query:

```ts
async list(params: { limit?: number; offset?: number } = {}): Promise<{
  items: ContactWithIdentifiers[];
  total: number;
}> {
  const db = this.dbService.db;
  const limit = params.limit || 50;
  const offset = params.offset || 0;

  const total = (await db.select({ count: sql<number>`count(*)` }).from(contacts))[0].count;
  const paged = await db.select().from(contacts).limit(limit).offset(offset);

  if (!paged.length) return { items: [], total };

  const ids = paged.map((c) => c.id);
  const allIdents = await db.select().from(contactIdentifiers)
    .where(sql`${contactIdentifiers.contactId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);

  // Group identifiers by contactId
  const identMap = new Map<string, typeof allIdents>();
  for (const ident of allIdents) {
    if (!identMap.has(ident.contactId)) identMap.set(ident.contactId, []);
    identMap.get(ident.contactId)!.push(ident);
  }

  const items: ContactWithIdentifiers[] = paged.map((c) => ({
    ...c,
    identifiers: (identMap.get(c.id) || []).map((i) => ({
      id: i.id,
      identifierType: i.identifierType,
      identifierValue: i.identifierValue,
      connectorType: i.connectorType,
      confidence: i.confidence,
    })),
  }));

  return { items, total };
}
```

9. Update `resolveContact` to use `avatars` instead of `avatarUrl` — the `db.insert(contacts).values(...)` call should not set `avatarUrl` (the column no longer exists; `avatars` defaults to `'[]'`).

**Step 4: Run tests**

Run: `cd /Users/amr/Projects/botmem && pnpm vitest run apps/api/src/contacts/__tests__/contacts.service.test.ts`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add apps/api/src/contacts/
git commit -m "feat: add updateContact, mergeContacts, deleteContact, getSuggestions to ContactsService"
```

---

### Task 3: ContactsController — New Endpoints

**Files:**
- Modify: `apps/api/src/contacts/contacts.controller.ts`

**Step 1: Implement new endpoints**

Replace `apps/api/src/contacts/contacts.controller.ts`:

```ts
import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { ContactsService } from './contacts.service';

@Controller('contacts')
export class ContactsController {
  constructor(private contactsService: ContactsService) {}

  @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.contactsService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('suggestions')
  async getSuggestions() {
    return this.contactsService.getSuggestions();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.contactsService.getById(id);
  }

  @Get(':id/memories')
  async getMemories(@Param('id') id: string) {
    return this.contactsService.getMemories(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: {
    displayName?: string;
    avatars?: Array<{ url: string; source: string }>;
    metadata?: Record<string, unknown>;
  }) {
    return this.contactsService.updateContact(id, body);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.contactsService.deleteContact(id);
    return { deleted: true };
  }

  @Post('search')
  async search(@Body() body: { query: string }) {
    return this.contactsService.search(body.query);
  }

  @Post(':id/merge')
  async merge(@Param('id') id: string, @Body() body: { sourceId: string }) {
    return this.contactsService.mergeContacts(id, body.sourceId);
  }

  @Post('suggestions/dismiss')
  async dismissSuggestion(@Body() body: { contactId1: string; contactId2: string }) {
    await this.contactsService.dismissSuggestion(body.contactId1, body.contactId2);
    return { dismissed: true };
  }
}
```

**Important:** The `suggestions` GET route must come BEFORE the `:id` GET route, otherwise NestJS will try to parse "suggestions" as an `:id` param.

**Step 2: Verify build**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add apps/api/src/contacts/contacts.controller.ts
git commit -m "feat: add PATCH, DELETE, merge, suggestions endpoints to ContactsController"
```

---

### Task 4: Fix EmbedProcessor — Contact Resolution for File Events

**Files:**
- Modify: `apps/api/src/memory/embed.processor.ts:130-140`

**Step 1: Write failing test**

In `apps/api/src/memory/__tests__/embed.processor.test.ts`, add a test case (adapt to existing mock patterns) that verifies when `event.sourceType === 'file'` and `connectorType === 'photos'`, the `resolvePhotosContacts` path is still called. Since the embed processor tests may use mocks, the key assertion is that `contactsService.resolveContact` is called even for file events.

**Step 2: Fix the bypass**

In `apps/api/src/memory/embed.processor.ts`, change the `sourceType === 'file'` block (lines 131-139) to resolve contacts BEFORE returning:

```ts
// Route file events to the file processor for content extraction
if (event.sourceType === 'file') {
  this.addLog(rawEvent.connectorType, rawEvent.accountId, 'info',
    `[embed:file-route] ${mid} → file queue for content extraction`);

  // Resolve contacts before routing to file processor
  try {
    await this.resolveContacts(memoryId, rawEvent.connectorType, event);
  } catch (err) {
    console.error('Contact resolution failed for file event:', err);
  }

  await this.fileQueue.add(
    'file',
    { memoryId },
    { attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
  );
  return;
}
```

**Step 3: Run all embed processor tests**

Run: `cd /Users/amr/Projects/botmem && pnpm vitest run apps/api/src/memory/__tests__/embed.processor.test.ts`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add apps/api/src/memory/embed.processor.ts
git commit -m "fix: resolve contacts for file events before routing to file processor"
```

---

### Task 5: Avatar Download in resolvePhotosContacts

**Files:**
- Modify: `apps/api/src/memory/embed.processor.ts:401-433`

**Step 1: Add avatar download logic**

In the `resolvePhotosContacts` method, after resolving each person, download their face thumbnail and store it on the contact. The connector already passes the Immich host in `auth.raw.host` and the API key in `auth.accessToken` — but `resolvePhotosContacts` only receives `metadata` and `participants`. We need to pass `rawEvent.accountId` so we can look up auth context.

Update the `resolveContacts` method signature and calls to pass `accountId`:

```ts
private async resolveContacts(
  memoryId: string,
  connectorType: string,
  event: ConnectorDataEvent,
  accountId?: string,
): Promise<void> {
```

And in `process()`, update both call sites:
```ts
await this.resolveContacts(memoryId, rawEvent.connectorType, event, rawEvent.accountId);
```

Then update `resolvePhotosContacts` to accept `accountId` and download avatars:

```ts
private async resolvePhotosContacts(
  memoryId: string,
  metadata: Record<string, unknown>,
  participants: string[],
  accountId?: string,
): Promise<void> {
  const people = (metadata.people as Array<{ id: string; name: string; birthDate?: string }>) || [];
  const resolvedNames = new Set<string>();

  // Look up Immich host + API key from account auth
  let immichHost: string | null = null;
  let immichApiKey: string | null = null;
  if (accountId) {
    try {
      const accRows = await this.dbService.db.select().from(accounts).where(eq(accounts.id, accountId));
      if (accRows.length && accRows[0].authContext) {
        const auth = JSON.parse(accRows[0].authContext);
        immichHost = auth.raw?.host as string;
        immichApiKey = auth.accessToken as string;
      }
    } catch {
      // Non-fatal
    }
  }

  for (const person of people) {
    if (!person.name) continue;

    const identifiers: IdentifierInput[] = [
      { type: 'name', value: person.name, connectorType: 'photos' },
      { type: 'immich_person_id', value: person.id, connectorType: 'photos' },
    ];

    const contact = await this.contactsService.resolveContact(identifiers);
    await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
    resolvedNames.add(person.name);

    // Download and store avatar if not already present
    if (immichHost && immichApiKey) {
      try {
        const existingAvatars: Array<{ url: string; source: string }> = JSON.parse(contact.avatars || '[]');
        const hasImmichAvatar = existingAvatars.some((a) => a.source === 'immich');
        if (!hasImmichAvatar) {
          const thumbUrl = `${immichHost}/api/people/${person.id}/thumbnail`;
          const res = await fetch(thumbUrl, {
            headers: { 'x-api-key': immichApiKey },
          });
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const contentType = res.headers.get('content-type') || 'image/jpeg';
            const dataUri = `data:${contentType};base64,${base64}`;
            existingAvatars.push({ url: dataUri, source: 'immich' });
            await this.contactsService.updateContact(contact.id, { avatars: existingAvatars });
          }
        }
      } catch {
        // Avatar download is best-effort
      }
    }
  }

  // Also resolve any participants not already handled via the people array
  for (const name of participants) {
    if (!name || resolvedNames.has(name)) continue;
    const identifiers: IdentifierInput[] = [
      { type: 'name', value: name, connectorType: 'photos' },
    ];
    const contact = await this.contactsService.resolveContact(identifiers);
    await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
  }
}
```

Update the switch case in `resolveContacts` to pass accountId:
```ts
case 'photos':
  await this.resolvePhotosContacts(memoryId, metadata, participants, accountId);
  break;
```

Add import for `accounts` from schema at the top of the file.

**Step 2: Verify build**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add apps/api/src/memory/embed.processor.ts
git commit -m "feat: download Immich face thumbnails and store as contact avatars"
```

---

### Task 6: Fix Immich Test — sourceType Assertion

**Files:**
- Modify: `packages/connectors/photos-immich/src/__tests__/immich.test.ts:238`

**Step 1: Fix the assertion**

Change line 238 from:
```ts
expect(event.sourceType).toBe('photo');
```
to:
```ts
expect(event.sourceType).toBe('file');
```

**Step 2: Run tests**

Run: `cd /Users/amr/Projects/botmem && pnpm vitest run packages/connectors/photos-immich/src/__tests__/immich.test.ts`
Expected: All 16 tests pass.

**Step 3: Commit**

```bash
git add packages/connectors/photos-immich/src/__tests__/immich.test.ts
git commit -m "fix: update Immich test to expect sourceType 'file' matching actual connector behavior"
```

---

### Task 7: Frontend API Client + Zustand Store

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/store/contactStore.ts`

**Step 1: Add API methods**

Add to `apps/web/src/lib/api.ts` in the Contacts section:

```ts
updateContact: (id: string, data: { displayName?: string; avatars?: Array<{ url: string; source: string }>; metadata?: Record<string, unknown> }) =>
  request<any>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
mergeContacts: (targetId: string, sourceId: string) =>
  request<any>(`/contacts/${targetId}/merge`, { method: 'POST', body: JSON.stringify({ sourceId }) }),
deleteContact: (id: string) =>
  request<any>(`/contacts/${id}`, { method: 'DELETE' }),
getMergeSuggestions: () =>
  request<Array<{ contact1: any; contact2: any; reason: string }>>('/contacts/suggestions'),
dismissSuggestion: (contactId1: string, contactId2: string) =>
  request<any>('/contacts/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ contactId1, contactId2 }) }),
```

**Step 2: Create Zustand store**

Create `apps/web/src/store/contactStore.ts`:

```ts
import { create } from 'zustand';
import { api } from '../lib/api';

export interface ContactAvatar {
  url: string;
  source: string;
}

export interface ContactIdentifier {
  id: string;
  identifierType: string;
  identifierValue: string;
  connectorType: string | null;
  confidence: number;
}

export interface Contact {
  id: string;
  displayName: string;
  avatars: ContactAvatar[];
  identifiers: ContactIdentifier[];
  metadata: Record<string, unknown>;
  memoryCount?: number;
}

export interface MergeSuggestion {
  contact1: Contact;
  contact2: Contact;
  reason: string;
}

function parseContact(raw: any): Contact {
  return {
    id: raw.id,
    displayName: raw.displayName,
    avatars: typeof raw.avatars === 'string' ? JSON.parse(raw.avatars) : (raw.avatars || []),
    identifiers: raw.identifiers || [],
    metadata: typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : (raw.metadata || {}),
  };
}

interface ContactState {
  contacts: Contact[];
  total: number;
  suggestions: MergeSuggestion[];
  selectedId: string | null;
  searchQuery: string;
  loading: boolean;

  loadContacts: (params?: { limit?: number; offset?: number }) => Promise<void>;
  searchContacts: (query: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  loadSuggestions: () => Promise<void>;
  selectContact: (id: string | null) => void;
  updateContact: (id: string, data: { displayName?: string; avatars?: ContactAvatar[]; metadata?: Record<string, unknown> }) => Promise<void>;
  mergeContacts: (targetId: string, sourceId: string) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  dismissSuggestion: (contactId1: string, contactId2: string) => Promise<void>;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useContactStore = create<ContactState>((set, get) => ({
  contacts: [],
  total: 0,
  suggestions: [],
  selectedId: null,
  searchQuery: '',
  loading: false,

  loadContacts: async (params) => {
    set({ loading: true });
    try {
      const result = await api.listContacts(params);
      set({ contacts: result.items.map(parseContact), total: result.total, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  searchContacts: async (query) => {
    set({ loading: true });
    try {
      const results = await api.searchContacts(query);
      set({ contacts: results.map(parseContact), total: results.length, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (q.trim()) get().searchContacts(q);
      else get().loadContacts();
    }, 300);
  },

  loadSuggestions: async () => {
    try {
      const suggestions = await api.getMergeSuggestions();
      set({
        suggestions: suggestions.map((s) => ({
          contact1: parseContact(s.contact1),
          contact2: parseContact(s.contact2),
          reason: s.reason,
        })),
      });
    } catch {
      // Non-critical
    }
  },

  selectContact: (id) => set({ selectedId: id }),

  updateContact: async (id, data) => {
    const updated = await api.updateContact(id, data);
    const parsed = parseContact(updated);
    set((state) => ({
      contacts: state.contacts.map((c) => (c.id === id ? parsed : c)),
    }));
  },

  mergeContacts: async (targetId, sourceId) => {
    await api.mergeContacts(targetId, sourceId);
    await get().loadContacts();
    await get().loadSuggestions();
    if (get().selectedId === sourceId) set({ selectedId: null });
  },

  deleteContact: async (id) => {
    await api.deleteContact(id);
    set((state) => ({
      contacts: state.contacts.filter((c) => c.id !== id),
      total: state.total - 1,
      selectedId: state.selectedId === id ? null : state.selectedId,
    }));
  },

  dismissSuggestion: async (contactId1, contactId2) => {
    await api.dismissSuggestion(contactId1, contactId2);
    set((state) => ({
      suggestions: state.suggestions.filter(
        (s) => !((s.contact1.id === contactId1 && s.contact2.id === contactId2) ||
                 (s.contact1.id === contactId2 && s.contact2.id === contactId1)),
      ),
    }));
  },
}));
```

**Step 3: Verify build**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/store/contactStore.ts
git commit -m "feat: add contacts API methods and Zustand store"
```

---

### Task 8: ContactsPage + Components (Neobrutal UI)

**Files:**
- Create: `apps/web/src/pages/ContactsPage.tsx`
- Create: `apps/web/src/components/contacts/ContactCard.tsx`
- Create: `apps/web/src/components/contacts/ContactDetailPanel.tsx`
- Create: `apps/web/src/components/contacts/MergeSuggestionRow.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

**Step 1: Create ContactCard component**

Create `apps/web/src/components/contacts/ContactCard.tsx`:

```tsx
import { cn } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import type { Contact } from '../../store/contactStore';

const TYPE_COLORS: Record<string, string> = {
  email: '#22D3EE',
  phone: '#22C55E',
  slack_id: '#A855F7',
  immich_person_id: '#FFE66D',
  imessage_handle: '#4ECDC4',
  name: '#9CA3AF',
};

interface ContactCardProps {
  contact: Contact;
  selected?: boolean;
  onClick?: () => void;
}

export function ContactCard({ contact, selected, onClick }: ContactCardProps) {
  const avatar = contact.avatars[0];
  const connectors = [...new Set(contact.identifiers.map((i) => i.connectorType).filter(Boolean))];

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left border-3 border-nb-border bg-nb-surface p-3 cursor-pointer',
        'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-nb-sm transition-all duration-100',
        selected ? 'shadow-none translate-x-[2px] translate-y-[2px] border-nb-lime' : 'shadow-nb',
      )}
    >
      <div className="flex items-center gap-3">
        {avatar ? (
          <img
            src={avatar.url}
            alt={contact.displayName}
            className="w-10 h-10 border-3 border-nb-border object-cover"
          />
        ) : (
          <div className="w-10 h-10 border-3 border-nb-border bg-nb-surface-muted flex items-center justify-center font-display font-bold text-nb-text text-sm">
            {contact.displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-display text-sm font-bold uppercase text-nb-text truncate">
            {contact.displayName}
          </p>
          <div className="flex flex-wrap gap-1 mt-1">
            {contact.identifiers
              .filter((i) => i.identifierType !== 'name')
              .slice(0, 3)
              .map((i) => (
                <Badge key={i.id} color={TYPE_COLORS[i.identifierType]}>
                  {i.identifierValue.length > 24 ? i.identifierValue.slice(0, 24) + '…' : i.identifierValue}
                </Badge>
              ))}
            {contact.identifiers.filter((i) => i.identifierType !== 'name').length > 3 && (
              <Badge>+{contact.identifiers.filter((i) => i.identifierType !== 'name').length - 3}</Badge>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {connectors.map((c) => (
            <span key={c} className="font-mono text-[10px] text-nb-muted uppercase">{c}</span>
          ))}
        </div>
      </div>
    </button>
  );
}
```

**Step 2: Create MergeSuggestionRow component**

Create `apps/web/src/components/contacts/MergeSuggestionRow.tsx`:

```tsx
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import type { MergeSuggestion } from '../../store/contactStore';

interface MergeSuggestionRowProps {
  suggestion: MergeSuggestion;
  onMerge: (targetId: string, sourceId: string) => void;
  onDismiss: (id1: string, id2: string) => void;
}

function MiniContactCard({ contact }: { contact: MergeSuggestion['contact1'] }) {
  const avatar = contact.avatars[0];
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {avatar ? (
        <img src={avatar.url} alt="" className="w-8 h-8 border-2 border-nb-border object-cover" />
      ) : (
        <div className="w-8 h-8 border-2 border-nb-border bg-nb-surface-muted flex items-center justify-center font-display font-bold text-nb-text text-xs">
          {contact.displayName.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <p className="font-display text-xs font-bold uppercase text-nb-text truncate">{contact.displayName}</p>
        <div className="flex gap-1 flex-wrap">
          {contact.identifiers.filter((i) => i.identifierType !== 'name').slice(0, 2).map((i) => (
            <span key={i.id} className="font-mono text-[10px] text-nb-muted">{i.identifierValue}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MergeSuggestionRow({ suggestion, onMerge, onDismiss }: MergeSuggestionRowProps) {
  const { contact1, contact2, reason } = suggestion;
  // Merge into the one with more identifiers
  const targetId = contact1.identifiers.length >= contact2.identifiers.length ? contact1.id : contact2.id;
  const sourceId = targetId === contact1.id ? contact2.id : contact1.id;

  return (
    <div className="border-3 border-nb-border bg-nb-surface p-3">
      <p className="font-mono text-[10px] text-nb-muted uppercase mb-2">{reason}</p>
      <div className="flex items-center gap-3">
        <MiniContactCard contact={contact1} />
        <span className="font-display font-bold text-nb-muted">↔</span>
        <MiniContactCard contact={contact2} />
        <div className="flex gap-2 flex-shrink-0">
          <Button size="sm" onClick={() => onMerge(targetId, sourceId)}>MERGE</Button>
          <Button size="sm" variant="secondary" onClick={() => onDismiss(contact1.id, contact2.id)}>✕</Button>
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Create ContactDetailPanel component**

Create `apps/web/src/components/contacts/ContactDetailPanel.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { useContactStore, type Contact, type ContactAvatar } from '../../store/contactStore';

const TYPE_COLORS: Record<string, string> = {
  email: '#22D3EE',
  phone: '#22C55E',
  slack_id: '#A855F7',
  immich_person_id: '#FFE66D',
  imessage_handle: '#4ECDC4',
  name: '#9CA3AF',
};

interface ContactDetailPanelProps {
  contact: Contact;
  onClose: () => void;
}

export function ContactDetailPanel({ contact, onClose }: ContactDetailPanelProps) {
  const { updateContact, deleteContact } = useContactStore();
  const [name, setName] = useState(contact.displayName);
  const [memories, setMemories] = useState<any[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(contact.displayName);
    setConfirmDelete(false);
    api.getContactMemories(contact.id).then(setMemories).catch(() => {});
  }, [contact.id]);

  const handleSaveName = () => {
    if (name !== contact.displayName) {
      updateContact(contact.id, { displayName: name });
    }
  };

  const handleDelete = () => {
    if (confirmDelete) {
      deleteContact(contact.id);
      onClose();
    } else {
      setConfirmDelete(true);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg font-bold uppercase text-nb-text">Contact Detail</h3>
        <button
          onClick={onClose}
          className="border-2 border-nb-border w-8 h-8 flex items-center justify-center font-bold hover:bg-nb-red hover:text-white cursor-pointer text-nb-text"
        >
          X
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {/* Avatars */}
        {contact.avatars.length > 0 && (
          <div className="flex gap-2">
            {contact.avatars.map((a, i) => (
              <div key={i} className="relative">
                <img src={a.url} alt="" className="w-16 h-16 border-3 border-nb-border object-cover" />
                <span className="absolute -bottom-1 -right-1 font-mono text-[9px] bg-nb-surface border border-nb-border px-1">
                  {a.source}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Display Name */}
        <div>
          <label className="font-display text-xs font-bold uppercase text-nb-muted mb-1 block">Name</label>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              className="flex-1 border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-3 py-2"
            />
          </div>
        </div>

        {/* Identifiers */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">Identifiers</h4>
          <div className="flex flex-col gap-1.5">
            {contact.identifiers.map((i) => (
              <div key={i.id} className="flex items-center gap-2">
                <Badge color={TYPE_COLORS[i.identifierType]}>{i.identifierType}</Badge>
                <span className="font-mono text-xs text-nb-text break-all">{i.identifierValue}</span>
                {i.connectorType && (
                  <span className="font-mono text-[10px] text-nb-muted">({i.connectorType})</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Linked Memories */}
        <div>
          <h4 className="font-display text-xs font-bold uppercase mb-2 text-nb-text">
            Memories ({memories.length})
          </h4>
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {memories.slice(0, 20).map((m: any) => (
              <div key={m.id} className="border-2 border-nb-border p-2 bg-nb-surface-muted">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] text-nb-muted">{m.connectorType}</span>
                  <span className="font-mono text-[10px] text-nb-muted">
                    {m.eventTime ? new Date(m.eventTime).toLocaleDateString() : ''}
                  </span>
                </div>
                <p className="font-mono text-xs text-nb-text line-clamp-2">{m.text}</p>
              </div>
            ))}
            {memories.length === 0 && (
              <p className="font-mono text-xs text-nb-muted text-center py-2">No linked memories</p>
            )}
          </div>
        </div>

        {/* Delete */}
        <div className="mt-2">
          <Button variant="danger" size="sm" onClick={handleDelete}>
            {confirmDelete ? 'CONFIRM DELETE' : 'DELETE CONTACT'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

**Step 4: Create ContactsPage**

Create `apps/web/src/pages/ContactsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { PageContainer } from '../components/layout/PageContainer';
import { Card } from '../components/ui/Card';
import { ContactCard } from '../components/contacts/ContactCard';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import { MergeSuggestionRow } from '../components/contacts/MergeSuggestionRow';
import { useContactStore } from '../store/contactStore';

export function ContactsPage() {
  const {
    contacts, total, suggestions, selectedId, searchQuery, loading,
    loadContacts, loadSuggestions, selectContact, setSearchQuery,
    mergeContacts, dismissSuggestion,
  } = useContactStore();
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);

  useEffect(() => {
    loadContacts();
    loadSuggestions();
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId) || null;

  return (
    <PageContainer>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-nb-text mb-6">
        CONTACTS
      </h1>

      {/* Suggested Merges */}
      {suggestions.length > 0 && (
        <Card className="mb-6 p-0 overflow-hidden">
          <button
            onClick={() => setSuggestionsOpen(!suggestionsOpen)}
            className="w-full flex items-center justify-between p-4 cursor-pointer hover:bg-nb-surface-hover transition-colors text-nb-text"
          >
            <div className="flex items-center gap-2">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider">
                Suggested Merges
              </h2>
              <span className="border-2 border-nb-border px-2 py-0.5 font-mono text-xs font-bold bg-nb-lime text-black">
                {suggestions.length}
              </span>
            </div>
            <span className="font-bold text-lg">{suggestionsOpen ? '−' : '+'}</span>
          </button>
          {suggestionsOpen && (
            <div className="border-t-3 border-nb-border p-3 flex flex-col gap-2 bg-nb-surface-muted">
              {suggestions.map((s, i) => (
                <MergeSuggestionRow
                  key={`${s.contact1.id}-${s.contact2.id}`}
                  suggestion={s}
                  onMerge={mergeContacts}
                  onDismiss={dismissSuggestion}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full border-3 border-nb-border bg-nb-surface font-mono text-sm text-nb-text px-4 py-3 placeholder:text-nb-muted placeholder:uppercase"
        />
      </div>

      {/* Contact List + Detail Panel */}
      <div className="flex gap-4">
        <div className="flex-1 flex flex-col gap-2">
          {loading ? (
            <p className="font-mono text-sm text-nb-muted text-center py-8">Loading...</p>
          ) : contacts.length === 0 ? (
            <p className="font-mono text-sm text-nb-muted text-center py-8 uppercase">
              No contacts found
            </p>
          ) : (
            <>
              <p className="font-mono text-xs text-nb-muted mb-1">{total} contacts</p>
              {contacts.map((c) => (
                <ContactCard
                  key={c.id}
                  contact={c}
                  selected={c.id === selectedId}
                  onClick={() => selectContact(c.id === selectedId ? null : c.id)}
                />
              ))}
            </>
          )}
        </div>

        {selectedContact && (
          <div className="w-96 flex-shrink-0">
            <ContactDetailPanel
              contact={selectedContact}
              onClose={() => selectContact(null)}
            />
          </div>
        )}
      </div>
    </PageContainer>
  );
}
```

**Step 5: Add route and nav item**

In `apps/web/src/App.tsx`, add import and route:

```tsx
import { ContactsPage } from './pages/ContactsPage';
```

Add inside the Shell routes (after `memories` route, before `settings`):
```tsx
<Route path="contacts" element={<ContactsPage />} />
```

In `apps/web/src/components/layout/Sidebar.tsx`, add to `navItems` array (after MEMORIES, before SETTINGS):

```ts
{ to: '/contacts', label: 'CONTACTS', icon: '◎' },
```

**Step 6: Verify build**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Expected: Build succeeds.

**Step 7: Commit**

```bash
git add apps/web/src/pages/ContactsPage.tsx apps/web/src/components/contacts/ apps/web/src/App.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat: add contacts page with merge suggestions, search, and detail panel"
```

---

### Task 9: Visual Verification + Polish

**Step 1: Build and verify API restarted**

Run: `cd /Users/amr/Projects/botmem && pnpm build`
Then hit `GET /api/version` to confirm.

**Step 2: Verify contacts API works**

Run: `curl http://localhost:3001/api/contacts?limit=5`
Expected: Returns `{ items: [...], total: N }` with contacts having `avatars` (JSON string), `identifiers` array.

Run: `curl http://localhost:3001/api/contacts/suggestions`
Expected: Returns array of suggestions (may be empty if no cross-connector name overlaps exist yet).

**Step 3: Take screenshot of contacts page**

Open `http://localhost:5173/contacts` in browser.
Verify:
- Neobrutal design matches existing pages
- Search bar works
- Contact cards show avatars or initials
- Clicking a card opens the detail panel on the right
- Suggested merges section appears if suggestions exist

**Step 4: Commit any polish fixes**

```bash
git add -A
git commit -m "chore: polish contacts page styling"
```
