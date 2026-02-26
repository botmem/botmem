import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, like, or, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { contacts, contactIdentifiers, memoryContacts, memories, accounts, mergeDismissals } from '../db/schema';

export interface IdentifierInput {
  type: string;
  value: string;
  connectorType?: string;
}

/**
 * Normalize a phone number to E.164 format.
 * Strips spaces, dashes, parens, dots. Converts leading 00 to +.
 * Returns the cleaned number with + prefix, or original if not parseable.
 */
/**
 * Normalize an email address: lowercase, strip plus-addressing (user+tag@domain → user@domain).
 */
export function normalizeEmail(raw: string): string {
  const email = raw.toLowerCase().trim();
  return email.replace(/^([^@+]+)\+[^@]*(@.+)$/, '$1$2');
}

export function normalizePhone(raw: string): string {
  // Strip all non-digit characters except leading +
  let digits = raw.replace(/[\s\-().]/g, '');

  // Convert leading 00 to +
  if (digits.startsWith('00')) {
    digits = '+' + digits.slice(2);
  }

  // Ensure + prefix
  if (!digits.startsWith('+')) {
    // If it's already 10+ digits, assume it has country code
    const justDigits = digits.replace(/\D/g, '');
    if (justDigits.length >= 10) {
      digits = '+' + justDigits;
    }
  }

  return digits;
}

export interface ContactWithIdentifiers {
  id: string;
  displayName: string;
  avatars: string;
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

    // Normalize identifiers before matching/storing
    for (const ident of identifiers) {
      if (ident.type === 'phone') {
        ident.value = normalizePhone(ident.value);
      } else if (ident.type === 'email') {
        ident.value = normalizeEmail(ident.value);
      }
    }

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

      for (const otherId of otherIds) {
        await db
          .update(contactIdentifiers)
          .set({ contactId })
          .where(eq(contactIdentifiers.contactId, otherId));

        await db
          .update(memoryContacts)
          .set({ contactId })
          .where(eq(memoryContacts.contactId, otherId));

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

    // Get total count without fetching all rows
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(contacts);
    const total = countResult[0].count;

    // Paginate with SQL LIMIT/OFFSET
    const paged = await db
      .select()
      .from(contacts)
      .limit(limit)
      .offset(offset);

    if (paged.length === 0) {
      return { items: [], total };
    }

    // Batch-fetch all identifiers for this page in one query
    const pagedIds = paged.map((c) => c.id);
    const allIdents = await db
      .select()
      .from(contactIdentifiers)
      .where(inArray(contactIdentifiers.contactId, pagedIds));

    // Group identifiers by contactId
    const identsByContact = new Map<string, typeof allIdents>();
    for (const ident of allIdents) {
      const list = identsByContact.get(ident.contactId) || [];
      list.push(ident);
      identsByContact.set(ident.contactId, list);
    }

    const items: ContactWithIdentifiers[] = paged.map((c) => {
      const idents = identsByContact.get(c.id) || [];
      return {
        ...c,
        identifiers: idents.map((i) => ({
          id: i.id,
          identifierType: i.identifierType,
          identifierValue: i.identifierValue,
          connectorType: i.connectorType,
          confidence: i.confidence,
        })),
      };
    });

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

  async getMemories(contactId: string, limit = 50): Promise<any[]> {
    const db = this.dbService.db;
    const mems = await db
      .select({ memory: memories })
      .from(memoryContacts)
      .innerJoin(memories, eq(memoryContacts.memoryId, memories.id))
      .where(eq(memoryContacts.contactId, contactId))
      .limit(limit);

    return mems.map((r) => r.memory);
  }

  async updateContact(
    id: string,
    updates: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ContactWithIdentifiers | null> {
    const db = this.dbService.db;

    // Check contact exists
    const existing = await db.select().from(contacts).where(eq(contacts.id, id));
    if (!existing.length) return null;

    const patch: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (updates.displayName !== undefined) patch.displayName = updates.displayName;
    if (updates.avatars !== undefined) patch.avatars = JSON.stringify(updates.avatars);
    if (updates.metadata !== undefined) patch.metadata = JSON.stringify(updates.metadata);

    await db.update(contacts).set(patch).where(eq(contacts.id, id));

    return this.getById(id);
  }

  async mergeContacts(targetId: string, sourceId: string): Promise<ContactWithIdentifiers> {
    const db = this.dbService.db;

    // Validate both exist
    const [targetRows, sourceRows] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.id, targetId)),
      db.select().from(contacts).where(eq(contacts.id, sourceId)),
    ]);

    if (!targetRows.length) throw new Error(`Target contact ${targetId} not found`);
    if (!sourceRows.length) throw new Error(`Source contact ${sourceId} not found`);

    const target = targetRows[0];
    const source = sourceRows[0];

    // Merge avatars (target first, then source, dedup by url)
    const targetAvatars: Array<{ url: string; source: string }> = JSON.parse(target.avatars || '[]');
    const sourceAvatars: Array<{ url: string; source: string }> = JSON.parse(source.avatars || '[]');
    const seenUrls = new Set(targetAvatars.map((a) => a.url));
    for (const avatar of sourceAvatars) {
      if (!seenUrls.has(avatar.url)) {
        targetAvatars.push(avatar);
        seenUrls.add(avatar.url);
      }
    }

    // Keep the longer displayName
    const displayName =
      source.displayName.length > target.displayName.length ? source.displayName : target.displayName;

    await db
      .update(contactIdentifiers)
      .set({ contactId: targetId })
      .where(eq(contactIdentifiers.contactId, sourceId));

    await db
      .update(memoryContacts)
      .set({ contactId: targetId })
      .where(eq(memoryContacts.contactId, sourceId));

    await db
      .update(contacts)
      .set({
        displayName,
        avatars: JSON.stringify(targetAvatars),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contacts.id, targetId));

    await db.delete(contacts).where(eq(contacts.id, sourceId));

    await db
      .delete(mergeDismissals)
      .where(
        or(
          eq(mergeDismissals.contactId1, sourceId),
          eq(mergeDismissals.contactId2, sourceId),
        )!,
      );

    return this.getById(targetId) as Promise<ContactWithIdentifiers>;
  }

  async deleteContact(id: string): Promise<void> {
    const db = this.dbService.db;

    await db.delete(memoryContacts).where(eq(memoryContacts.contactId, id));
    await db.delete(contactIdentifiers).where(eq(contactIdentifiers.contactId, id));
    await db
      .delete(mergeDismissals)
      .where(
        or(
          eq(mergeDismissals.contactId1, id),
          eq(mergeDismissals.contactId2, id),
        )!,
      );
    await db.delete(contacts).where(eq(contacts.id, id));
  }

  async getSuggestions(): Promise<
    Array<{
      contact1: ContactWithIdentifiers;
      contact2: ContactWithIdentifiers;
      reason: string;
    }>
  > {
    const db = this.dbService.db;

    // Load all contacts + identifiers + dismissals
    const allContacts = await db.select().from(contacts);
    const allIdentifiers = await db.select().from(contactIdentifiers);
    const allDismissals = await db.select().from(mergeDismissals);

    // Build contact -> connector types map
    const contactConnectors = new Map<string, Set<string>>();
    for (const ident of allIdentifiers) {
      if (ident.connectorType) {
        const set = contactConnectors.get(ident.contactId) || new Set();
        set.add(ident.connectorType);
        contactConnectors.set(ident.contactId, set);
      }
    }

    // Build dismissed pairs set (sorted id pair as key)
    const dismissedPairs = new Set<string>();
    for (const d of allDismissals) {
      const key = [d.contactId1, d.contactId2].sort().join('::');
      dismissedPairs.add(key);
    }

    // Build identifiers map for quick lookup
    const contactIdentsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = contactIdentsMap.get(ident.contactId) || [];
      list.push(ident);
      contactIdentsMap.set(ident.contactId, list);
    }

    const suggestions: Array<{
      contact1: ContactWithIdentifiers;
      contact2: ContactWithIdentifiers;
      reason: string;
    }> = [];

    for (let i = 0; i < allContacts.length; i++) {
      for (let j = i + 1; j < allContacts.length; j++) {
        const c1 = allContacts[i];
        const c2 = allContacts[j];

        // Skip if dismissed
        const pairKey = [c1.id, c2.id].sort().join('::');
        if (dismissedPairs.has(pairKey)) continue;

        // Skip if both contacts ONLY come from the same single connector
        const connectors1 = contactConnectors.get(c1.id) || new Set();
        const connectors2 = contactConnectors.get(c2.id) || new Set();
        if (connectors1.size === 1 && connectors2.size === 1) {
          const [only1] = connectors1;
          const [only2] = connectors2;
          if (only1 === only2) continue;
        }

        // Case-insensitive substring match on displayName
        // Require min 3 chars and shorter name >= 40% of longer to avoid "Google" matching "John (Google Slides)"
        const nameA = c1.displayName.toLowerCase();
        const nameB = c2.displayName.toLowerCase();
        if (nameA.length < 3 || nameB.length < 3) continue;
        const shorter = Math.min(nameA.length, nameB.length);
        const longer = Math.max(nameA.length, nameB.length);
        if (shorter / longer < 0.4) continue;
        if (nameA.includes(nameB) || nameB.includes(nameA)) {
          const idents1 = contactIdentsMap.get(c1.id) || [];
          const idents2 = contactIdentsMap.get(c2.id) || [];

          suggestions.push({
            contact1: {
              ...c1,
              identifiers: idents1.map((id) => ({
                id: id.id,
                identifierType: id.identifierType,
                identifierValue: id.identifierValue,
                connectorType: id.connectorType,
                confidence: id.confidence,
              })),
            },
            contact2: {
              ...c2,
              identifiers: idents2.map((id) => ({
                id: id.id,
                identifierType: id.identifierType,
                identifierValue: id.identifierValue,
                connectorType: id.connectorType,
                confidence: id.confidence,
              })),
            },
            reason: `Display names match: "${c1.displayName}" and "${c2.displayName}"`,
          });
        }
      }
    }

    return suggestions;
  }

  async dismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const db = this.dbService.db;
    const [id1, id2] = [contactId1, contactId2].sort();
    await db.insert(mergeDismissals).values({
      id: randomUUID(),
      contactId1: id1,
      contactId2: id2,
      createdAt: new Date().toISOString(),
    });
  }
}
