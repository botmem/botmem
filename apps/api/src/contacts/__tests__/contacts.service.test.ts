import { describe, it, expect, beforeEach } from 'vitest';
import { ContactsService, normalizePhone, normalizeIdentifier } from '../contacts.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, contacts, contactIdentifiers, memoryContacts, memories, mergeDismissals } from '../../db/schema';
import { eq } from 'drizzle-orm';

function makeDbService(db: any) {
  return { db } as any;
}

describe('normalizePhone', () => {
  it('converts 00 prefix to +', () => {
    expect(normalizePhone('00201027755722')).toBe('+201027755722');
  });

  it('preserves existing + prefix', () => {
    expect(normalizePhone('+971502284498')).toBe('+971502284498');
  });

  it('strips spaces, dashes, and parens', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
  });

  it('adds + to bare digit strings with country code', () => {
    expect(normalizePhone('201027755722')).toBe('+201027755722');
  });

  it('strips dots', () => {
    expect(normalizePhone('+1.555.123.4567')).toBe('+15551234567');
  });
});

describe('normalizeIdentifier', () => {
  it('trims whitespace from all types', () => {
    const result = normalizeIdentifier({ type: 'name', value: '  Amr Essam  ' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('collapses multiple spaces in names', () => {
    const result = normalizeIdentifier({ type: 'name', value: 'Amr   Essam' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('reclassifies email-like names as email type', () => {
    const result = normalizeIdentifier({ type: 'name', value: 'AmroEssamS@gmail.com' });
    expect(result!.type).toBe('email');
    expect(result!.value).toBe('amroessams@gmail.com');
  });

  it('lowercases emails', () => {
    const result = normalizeIdentifier({ type: 'email', value: 'Amr@Ghanem.SA' });
    expect(result!.value).toBe('amr@ghanem.sa');
  });

  it('lowercases slack_id and other generic types', () => {
    const result = normalizeIdentifier({ type: 'slack_id', value: ' AMR ' });
    expect(result!.value).toBe('amr');
  });

  it('strips zero-width and directional Unicode from names', () => {
    const result = normalizeIdentifier({ type: 'name', value: '\u200E Amr Essam' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('returns null for empty values after trim', () => {
    expect(normalizeIdentifier({ type: 'name', value: '   ' })).toBeNull();
  });

  it('strips plus-addressing from emails', () => {
    const result = normalizeIdentifier({ type: 'email', value: 'user+tag@example.com' });
    expect(result!.value).toBe('user@example.com');
  });

  it('normalizes phone numbers', () => {
    const result = normalizeIdentifier({ type: 'phone', value: '00 201 027 755 722' });
    expect(result!.value).toBe('+201027755722');
  });
});

describe('ContactsService', () => {
  let service: ContactsService;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    service = new ContactsService(makeDbService(db));

    await db.insert(accounts).values({
      id: 'acc-1',
      connectorType: 'gmail',
      identifier: 'test@example.com',
      status: 'connected',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    });
  });

  describe('resolveContact', () => {
    it('creates a new contact when no match exists', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'alice@example.com', connectorType: 'gmail' },
      ]);

      expect(contact.id).toBeDefined();
      expect(contact.displayName).toBe('alice@example.com');

      const identifiers = await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, contact.id));
      expect(identifiers).toHaveLength(1);
      expect(identifiers[0].identifierType).toBe('email');
      expect(identifiers[0].identifierValue).toBe('alice@example.com');
    });

    it('returns existing contact when identifier matches', async () => {
      const first = await service.resolveContact([
        { type: 'email', value: 'bob@example.com', connectorType: 'gmail' },
      ]);

      const second = await service.resolveContact([
        { type: 'email', value: 'bob@example.com', connectorType: 'slack' },
      ]);

      expect(second.id).toBe(first.id);
    });

    it('adds new identifiers to existing contact', async () => {
      const first = await service.resolveContact([
        { type: 'email', value: 'carol@example.com', connectorType: 'gmail' },
      ]);

      await service.resolveContact([
        { type: 'email', value: 'carol@example.com', connectorType: 'gmail' },
        { type: 'phone', value: '+1234567890', connectorType: 'whatsapp' },
      ]);

      const identifiers = await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, first.id));
      expect(identifiers).toHaveLength(2);
      const types = identifiers.map((i) => i.identifierType).sort();
      expect(types).toEqual(['email', 'phone']);
    });

    it('uses display name from name-type identifier', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'dave@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Dave Smith', connectorType: 'gmail' },
      ]);

      expect(contact.displayName).toBe('Dave Smith');
    });

    it('merges contacts when identifiers match different existing contacts', async () => {
      // Create two separate contacts
      const c1 = await service.resolveContact([
        { type: 'email', value: 'eve@example.com', connectorType: 'gmail' },
      ]);
      const c2 = await service.resolveContact([
        { type: 'phone', value: '+9876543210', connectorType: 'whatsapp' },
      ]);

      expect(c1.id).not.toBe(c2.id);

      // Now resolve with both identifiers — should merge
      const merged = await service.resolveContact([
        { type: 'email', value: 'eve@example.com', connectorType: 'gmail' },
        { type: 'phone', value: '+9876543210', connectorType: 'whatsapp' },
      ]);

      // The merged contact should have both identifiers
      const identifiers = await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, merged.id));
      expect(identifiers.length).toBeGreaterThanOrEqual(2);

      // The other contact should no longer exist
      const remaining = await db.select().from(contacts);
      expect(remaining).toHaveLength(1);
    });

    it('normalizes phone numbers to E.164 before storing', async () => {
      const contact = await service.resolveContact([
        { type: 'phone', value: '00201027755722', connectorType: 'slack' },
      ]);

      const identifiers = await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, contact.id));
      expect(identifiers[0].identifierValue).toBe('+201027755722');
    });

    it('matches phone numbers regardless of format', async () => {
      const c1 = await service.resolveContact([
        { type: 'phone', value: '+201027755722', connectorType: 'whatsapp' },
      ]);
      const c2 = await service.resolveContact([
        { type: 'phone', value: '00201027755722', connectorType: 'slack' },
      ]);

      expect(c2.id).toBe(c1.id);
    });
  });

  describe('getById', () => {
    it('returns contact with identifiers', async () => {
      const created = await service.resolveContact([
        { type: 'email', value: 'frank@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Frank', connectorType: 'gmail' },
      ]);

      const found = await service.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Frank');
      expect(found!.identifiers).toHaveLength(2);
    });

    it('returns null for non-existent contact', async () => {
      const found = await service.getById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('list', () => {
    it('returns paginated contacts', async () => {
      await service.resolveContact([{ type: 'email', value: 'a@test.com', connectorType: 'gmail' }]);
      await service.resolveContact([{ type: 'email', value: 'b@test.com', connectorType: 'gmail' }]);
      await service.resolveContact([{ type: 'email', value: 'c@test.com', connectorType: 'gmail' }]);

      const page1 = await service.list({ limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await service.list({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('finds contacts by name or identifier value', async () => {
      await service.resolveContact([
        { type: 'email', value: 'grace@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Grace Hopper', connectorType: 'gmail' },
      ]);
      await service.resolveContact([
        { type: 'email', value: 'alan@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Alan Turing', connectorType: 'gmail' },
      ]);

      const results = await service.search('grace');
      expect(results).toHaveLength(1);
      expect(results[0].displayName).toBe('Grace Hopper');
    });
  });

  describe('linkMemory', () => {
    it('creates memory_contacts junction row', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'hal@example.com', connectorType: 'gmail' },
      ]);

      // Insert a memory
      const now = new Date().toISOString();
      await db.insert(memories).values({
        id: 'mem-1',
        accountId: 'acc-1',
        connectorType: 'gmail',
        sourceType: 'email',
        sourceId: 'src-1',
        text: 'Hello from Hal',
        eventTime: now,
        ingestTime: now,
        createdAt: now,
      });

      await service.linkMemory('mem-1', contact.id, 'sender');

      const links = await db
        .select()
        .from(memoryContacts)
        .where(eq(memoryContacts.memoryId, 'mem-1'));
      expect(links).toHaveLength(1);
      expect(links[0].contactId).toBe(contact.id);
      expect(links[0].role).toBe('sender');
    });
  });

  describe('getMemories', () => {
    it('returns memories linked to a contact', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'iris@example.com', connectorType: 'gmail' },
      ]);

      const now = new Date().toISOString();
      await db.insert(memories).values({
        id: 'mem-2',
        accountId: 'acc-1',
        connectorType: 'gmail',
        sourceType: 'email',
        sourceId: 'src-2',
        text: 'Meeting with Iris',
        eventTime: now,
        ingestTime: now,
        createdAt: now,
      });

      await service.linkMemory('mem-2', contact.id, 'participant');

      const mems = await service.getMemories(contact.id);
      expect(mems).toHaveLength(1);
      expect(mems[0].id).toBe('mem-2');
    });
  });

  describe('updateContact', () => {
    it('updates displayName', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'update@test.com', connectorType: 'gmail' },
      ]);

      const updated = await service.updateContact(contact.id, { displayName: 'New Name' });
      expect(updated).not.toBeNull();
      expect(updated!.displayName).toBe('New Name');
    });

    it('updates avatars as JSON', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'avatar@test.com', connectorType: 'gmail' },
      ]);

      const avatars = [{ url: 'https://example.com/photo.jpg', source: 'gmail' }];
      const updated = await service.updateContact(contact.id, { avatars });
      expect(updated).not.toBeNull();
      expect(JSON.parse(updated!.avatars)).toEqual(avatars);
    });

    it('returns null for non-existent contact', async () => {
      const result = await service.updateContact('non-existent', { displayName: 'Test' });
      expect(result).toBeNull();
    });
  });

  describe('mergeContacts', () => {
    it('moves identifiers and memory links from source to target', async () => {
      const c1 = await service.resolveContact([
        { type: 'email', value: 'target@test.com', connectorType: 'gmail' },
        { type: 'name', value: 'Target Person', connectorType: 'gmail' },
      ]);
      const c2 = await service.resolveContact([
        { type: 'phone', value: '+1234567890', connectorType: 'whatsapp' },
        { type: 'name', value: 'Source Person With Long Name', connectorType: 'whatsapp' },
      ]);

      // Link a memory to the source contact
      const now = new Date().toISOString();
      await db.insert(memories).values({
        id: 'mem-merge',
        accountId: 'acc-1',
        connectorType: 'gmail',
        sourceType: 'email',
        sourceId: 'src-merge',
        text: 'Merge test',
        eventTime: now,
        ingestTime: now,
        createdAt: now,
      });
      await service.linkMemory('mem-merge', c2.id, 'sender');

      const merged = await service.mergeContacts(c1.id, c2.id);

      // Should have all identifiers
      expect(merged.identifiers.length).toBeGreaterThanOrEqual(3); // email + phone + names

      // Should keep the longer display name
      expect(merged.displayName).toBe('Source Person With Long Name');

      // Source contact should be gone
      const remaining = await db.select().from(contacts);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(c1.id);

      // Memory link should be moved to target
      const links = await db
        .select()
        .from(memoryContacts)
        .where(eq(memoryContacts.contactId, c1.id));
      expect(links).toHaveLength(1);
      expect(links[0].memoryId).toBe('mem-merge');
    });

    it('deduplicates avatars by url during merge', async () => {
      const c1 = await service.resolveContact([
        { type: 'email', value: 'ava1@test.com', connectorType: 'gmail' },
      ]);
      const c2 = await service.resolveContact([
        { type: 'email', value: 'ava2@test.com', connectorType: 'slack' },
      ]);

      await service.updateContact(c1.id, {
        avatars: [{ url: 'https://shared.com/photo.jpg', source: 'gmail' }],
      });
      await service.updateContact(c2.id, {
        avatars: [
          { url: 'https://shared.com/photo.jpg', source: 'slack' },
          { url: 'https://unique.com/photo.jpg', source: 'slack' },
        ],
      });

      const merged = await service.mergeContacts(c1.id, c2.id);
      const avatars = JSON.parse(merged.avatars);
      expect(avatars).toHaveLength(2); // shared + unique, not 3
    });
  });

  describe('deleteContact', () => {
    it('removes contact, identifiers, and memory links', async () => {
      const contact = await service.resolveContact([
        { type: 'email', value: 'delete@test.com', connectorType: 'gmail' },
      ]);

      const now = new Date().toISOString();
      await db.insert(memories).values({
        id: 'mem-del',
        accountId: 'acc-1',
        connectorType: 'gmail',
        sourceType: 'email',
        sourceId: 'src-del',
        text: 'Delete test',
        eventTime: now,
        ingestTime: now,
        createdAt: now,
      });
      await service.linkMemory('mem-del', contact.id, 'sender');

      await service.deleteContact(contact.id);

      const remainingContacts = await db.select().from(contacts);
      expect(remainingContacts).toHaveLength(0);

      const remainingIdents = await db.select().from(contactIdentifiers);
      expect(remainingIdents).toHaveLength(0);

      const remainingLinks = await db.select().from(memoryContacts);
      expect(remainingLinks).toHaveLength(0);
    });
  });

  describe('getSuggestions', () => {
    it('finds cross-connector name overlaps', async () => {
      await service.resolveContact([
        { type: 'email', value: 'john@gmail.com', connectorType: 'gmail' },
        { type: 'name', value: 'John Smith', connectorType: 'gmail' },
      ]);
      await service.resolveContact([
        { type: 'phone', value: '+1234567890', connectorType: 'whatsapp' },
        { type: 'name', value: 'John', connectorType: 'whatsapp' },
      ]);

      const suggestions = await service.getSuggestions();
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].reason).toContain('John');
    });

    it('excludes same-connector-only contacts', async () => {
      await service.resolveContact([
        { type: 'email', value: 'same1@test.com', connectorType: 'gmail' },
        { type: 'name', value: 'Same Person', connectorType: 'gmail' },
      ]);
      await service.resolveContact([
        { type: 'email', value: 'same2@test.com', connectorType: 'gmail' },
        { type: 'name', value: 'Same', connectorType: 'gmail' },
      ]);

      const suggestions = await service.getSuggestions();
      expect(suggestions).toHaveLength(0);
    });

    it('excludes dismissed pairs', async () => {
      const c1 = await service.resolveContact([
        { type: 'email', value: 'dismiss1@test.com', connectorType: 'gmail' },
        { type: 'name', value: 'Dismissed Person', connectorType: 'gmail' },
      ]);
      const c2 = await service.resolveContact([
        { type: 'phone', value: '+9999999999', connectorType: 'whatsapp' },
        { type: 'name', value: 'Dismissed', connectorType: 'whatsapp' },
      ]);

      await service.dismissSuggestion(c1.id, c2.id);

      const suggestions = await service.getSuggestions();
      expect(suggestions).toHaveLength(0);
    });
  });
});
