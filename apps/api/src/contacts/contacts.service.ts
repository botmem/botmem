import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, like, or, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { contacts, contactIdentifiers, memoryContacts, memories } from '../db/schema';

export interface IdentifierInput {
  type: string;
  value: string;
  connectorType?: string;
}

export interface ContactWithIdentifiers {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  identifiers: Array<{
    id: string;
    identifierType: string;
    identifierValue: string;
    connectorType: string | null;
    confidence: number;
  }>;
}

@Injectable()
export class ContactsService {
  constructor(private dbService: DbService) {}

  async resolveContact(identifiers: IdentifierInput[]): Promise<ContactWithIdentifiers> {
    const db = this.dbService.db;

    // Find all existing contacts matching any of the provided identifiers
    const matchedContactIds = new Set<string>();

    for (const ident of identifiers) {
      const rows = await db
        .select({ contactId: contactIdentifiers.contactId })
        .from(contactIdentifiers)
        .where(
          sql`${contactIdentifiers.identifierType} = ${ident.type} AND ${contactIdentifiers.identifierValue} = ${ident.value}`,
        );
      for (const row of rows) {
        matchedContactIds.add(row.contactId);
      }
    }

    const matchedIds = Array.from(matchedContactIds);
    let contactId: string;

    if (matchedIds.length === 0) {
      // Create new contact
      contactId = randomUUID();
      const now = new Date().toISOString();
      const nameIdent = identifiers.find((i) => i.type === 'name');
      const displayName = nameIdent?.value || identifiers[0]?.value || 'Unknown';

      await db.insert(contacts).values({
        id: contactId,
        displayName,
        createdAt: now,
        updatedAt: now,
      });
    } else if (matchedIds.length === 1) {
      contactId = matchedIds[0];
    } else {
      // Multiple contacts matched — merge them into the first one
      contactId = matchedIds[0];
      const otherIds = matchedIds.slice(1);

      // Move all identifiers from other contacts to primary
      for (const otherId of otherIds) {
        await db
          .update(contactIdentifiers)
          .set({ contactId })
          .where(eq(contactIdentifiers.contactId, otherId));

        // Move all memory links from other contacts to primary
        await db
          .update(memoryContacts)
          .set({ contactId })
          .where(eq(memoryContacts.contactId, otherId));

        // Delete the other contact
        await db.delete(contacts).where(eq(contacts.id, otherId));
      }
    }

    // Add any new identifiers that don't already exist
    const existingIdents = await db
      .select()
      .from(contactIdentifiers)
      .where(eq(contactIdentifiers.contactId, contactId));

    for (const ident of identifiers) {
      const exists = existingIdents.some(
        (e) => e.identifierType === ident.type && e.identifierValue === ident.value,
      );
      if (!exists) {
        await db.insert(contactIdentifiers).values({
          id: randomUUID(),
          contactId,
          identifierType: ident.type,
          identifierValue: ident.value,
          connectorType: ident.connectorType || null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Update display name if we have a name-type identifier
    const nameIdent = identifiers.find((i) => i.type === 'name');
    if (nameIdent) {
      await db
        .update(contacts)
        .set({ displayName: nameIdent.value, updatedAt: new Date().toISOString() })
        .where(eq(contacts.id, contactId));
    }

    return this.getById(contactId) as Promise<ContactWithIdentifiers>;
  }

  async getById(id: string): Promise<ContactWithIdentifiers | null> {
    const db = this.dbService.db;
    const rows = await db.select().from(contacts).where(eq(contacts.id, id));
    if (!rows.length) return null;

    const idents = await db
      .select()
      .from(contactIdentifiers)
      .where(eq(contactIdentifiers.contactId, id));

    return {
      ...rows[0],
      identifiers: idents.map((i) => ({
        id: i.id,
        identifierType: i.identifierType,
        identifierValue: i.identifierValue,
        connectorType: i.connectorType,
        confidence: i.confidence,
      })),
    };
  }

  async list(params: { limit?: number; offset?: number } = {}): Promise<{
    items: ContactWithIdentifiers[];
    total: number;
  }> {
    const db = this.dbService.db;
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const allContacts = await db.select().from(contacts);
    const total = allContacts.length;
    const paged = allContacts.slice(offset, offset + limit);

    const items: ContactWithIdentifiers[] = [];
    for (const c of paged) {
      const idents = await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, c.id));

      items.push({
        ...c,
        identifiers: idents.map((i) => ({
          id: i.id,
          identifierType: i.identifierType,
          identifierValue: i.identifierValue,
          connectorType: i.connectorType,
          confidence: i.confidence,
        })),
      });
    }

    return { items, total };
  }

  async search(query: string): Promise<ContactWithIdentifiers[]> {
    const db = this.dbService.db;
    const pattern = `%${query.toLowerCase()}%`;

    // Search by display name
    const nameMatches = await db
      .select()
      .from(contacts)
      .where(sql`LOWER(${contacts.displayName}) LIKE ${pattern}`);

    // Search by identifier value
    const identMatches = await db
      .select({ contactId: contactIdentifiers.contactId })
      .from(contactIdentifiers)
      .where(sql`LOWER(${contactIdentifiers.identifierValue}) LIKE ${pattern}`);

    const allIds = new Set<string>();
    for (const c of nameMatches) allIds.add(c.id);
    for (const i of identMatches) allIds.add(i.contactId);

    const results: ContactWithIdentifiers[] = [];
    for (const id of allIds) {
      const c = await this.getById(id);
      if (c) results.push(c);
    }

    return results;
  }

  async linkMemory(memoryId: string, contactId: string, role: string): Promise<void> {
    await this.dbService.db.insert(memoryContacts).values({
      id: randomUUID(),
      memoryId,
      contactId,
      role,
    });
  }

  async getMemories(contactId: string): Promise<any[]> {
    const db = this.dbService.db;
    const links = await db
      .select({ memoryId: memoryContacts.memoryId })
      .from(memoryContacts)
      .where(eq(memoryContacts.contactId, contactId));

    if (!links.length) return [];

    const memoryIds = links.map((l) => l.memoryId);
    const mems = await db
      .select()
      .from(memories)
      .where(inArray(memories.id, memoryIds));

    return mems;
  }
}
