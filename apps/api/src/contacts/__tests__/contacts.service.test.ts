import { describe, it, expect, beforeEach } from 'vitest';
import { ContactsService } from '../contacts.service';
import { createTestDb } from '../../__tests__/helpers/db.helper';
import { accounts, contacts, contactIdentifiers, memoryContacts, memories } from '../../db/schema';
import { eq } from 'drizzle-orm';

function makeDbService(db: any) {
  return { db } as any;
}

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
});
