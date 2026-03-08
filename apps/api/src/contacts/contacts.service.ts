import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, like, or, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { contacts, contactIdentifiers, memoryContacts, memories, accounts, mergeDismissals, settings } from '../db/schema';

export interface IdentifierInput {
  type: string;
  value: string;
  connectorType?: string;
}

/** Normalize an email: lowercase, trim, strip plus-addressing. */
export function normalizeEmail(raw: string): string {
  const email = raw.toLowerCase().trim();
  return email.replace(/^([^@+]+)\+[^@]*(@.+)$/, '$1$2');
}

/** Normalize a phone number to E.164 format. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (!digits.startsWith('+')) {
    const justDigits = digits.replace(/\D/g, '');
    if (justDigits.length >= 10) digits = '+' + justDigits;
  }
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize an identifier: trim, lowercase where appropriate, reclassify
 * email-like values stored as names, and collapse whitespace in names.
 * Returns null if the identifier should be dropped (empty after normalization).
 */
export function normalizeIdentifier(ident: IdentifierInput): IdentifierInput | null {
  let { type, value } = ident;
  value = value.trim();
  if (!value) return null;

  // Reclassify: if a "name" looks like an email, treat it as email
  if (type === 'name' && EMAIL_RE.test(value)) {
    type = 'email';
  }

  switch (type) {
    case 'email':
      value = normalizeEmail(value);
      break;
    case 'phone':
      value = normalizePhone(value);
      break;
    case 'name':
      // Strip zero-width / directional Unicode chars, collapse whitespace
      value = value.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      break;
    default:
      // slack_id, immich_person_id, etc. — lowercase + trim
      value = value.toLowerCase().trim();
      break;
  }

  if (!value) return null;
  return { ...ident, type, value };
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

  async resolveContact(rawIdentifiers: IdentifierInput[], entityType?: 'person' | 'group' | 'organization' | 'device'): Promise<ContactWithIdentifiers> {
    const db = this.dbService.db;

    // Normalize + deduplicate identifiers
    const seen = new Set<string>();
    const identifiers: IdentifierInput[] = [];
    for (const raw of rawIdentifiers) {
      const norm = normalizeIdentifier(raw);
      if (!norm) continue;
      const key = `${norm.type}::${norm.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identifiers.push(norm);
    }

    // Find existing contacts matching structured identifiers only
    // Names are too ambiguous for matching — only use email, phone, slack_id, etc.
    const matchedContactIds = new Set<string>();

    for (const ident of identifiers) {
      if (ident.type === 'name') continue; // Skip name-based matching
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
        entityType: entityType || 'person',
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
        try {
          await this.mergeContacts(contactId, otherId);
        } catch {
          // Concurrent merge may have already handled this — ignore
        }
      }
    }

    // Add any new identifiers that don't already exist.
    // The contact may be deleted by a concurrent merge — if so, find where
    // our identifiers ended up and switch to that contact.
    try {
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
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        // Contact was merged/deleted concurrently — find where identifiers went
        const probe = identifiers.find((i) => i.type !== 'name') || identifiers[0];
        if (probe) {
          const rows = await db
            .select({ contactId: contactIdentifiers.contactId })
            .from(contactIdentifiers)
            .where(sql`${contactIdentifiers.identifierType} = ${probe.type} AND ${contactIdentifiers.identifierValue} = ${probe.value}`)
            .limit(1);
          if (rows.length) {
            contactId = rows[0].contactId;
          }
        }
      } else {
        throw err;
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

    // Auto-merge: if any non-name identifier on this contact also belongs to
    // another contact, absorb that contact automatically.
    try {
      const allIdentsForContact = await db.select().from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, contactId));

      for (const ident of allIdentsForContact) {
        if (ident.identifierType === 'name') continue;
        const dupes = await db
          .select({ contactId: contactIdentifiers.contactId })
          .from(contactIdentifiers)
          .where(sql`${contactIdentifiers.identifierType} = ${ident.identifierType} AND ${contactIdentifiers.identifierValue} = ${ident.identifierValue} AND ${contactIdentifiers.contactId} != ${contactId}`);

        for (const dupe of dupes) {
          await this.mergeContacts(contactId, dupe.contactId);
        }
      }
    } catch (err) {
      // Auto-merge is best-effort — don't fail the resolve
      console.warn('[resolveContact] auto-merge failed:', err);
    }

    const result = await this.getById(contactId);
    if (!result) {
      // Contact was deleted by a concurrent merge — it was absorbed into another contact.
      // Find where our identifiers ended up.
      const movedIdent = identifiers.find((i) => i.type !== 'name') || identifiers[0];
      if (movedIdent) {
        const rows = await db
          .select({ contactId: contactIdentifiers.contactId })
          .from(contactIdentifiers)
          .where(sql`${contactIdentifiers.identifierType} = ${movedIdent.type} AND ${contactIdentifiers.identifierValue} = ${movedIdent.value}`)
          .limit(1);
        if (rows.length) {
          return this.getById(rows[0].contactId) as Promise<ContactWithIdentifiers>;
        }
      }
      throw new Error(`Contact ${contactId} was deleted during resolution`);
    }
    return result;
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

  async list(params: { limit?: number; offset?: number; entityType?: string } = {}): Promise<{
    items: ContactWithIdentifiers[];
    total: number;
  }> {
    const db = this.dbService.db;
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const where = params.entityType
      ? eq(contacts.entityType, params.entityType)
      : undefined;

    // Get total count without fetching all rows
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(where);
    const total = countResult[0].count;

    // Get selfContactId to pin it first
    const selfRow = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'selfContactId'))
      .limit(1);
    const selfContactId = selfRow[0]?.value || '';

    // Paginate: self-contact first, then by linked memory count desc
    const paged = await db
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        entityType: contacts.entityType,
        avatars: contacts.avatars,
        metadata: contacts.metadata,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .leftJoin(memoryContacts, eq(contacts.id, memoryContacts.contactId))
      .where(where)
      .groupBy(contacts.id)
      .orderBy(
        sql`CASE WHEN ${contacts.id} = ${selfContactId} THEN 0 ELSE 1 END`,
        sql`COUNT(${memoryContacts.memoryId}) DESC`,
      )
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
    const normQuery = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    // Search by display name (exact LIKE)
    const nameMatches = await db
      .select()
      .from(contacts)
      .where(sql`LOWER(${contacts.displayName}) LIKE ${pattern}`);

    // Accent-stripped fallback: if query is "amelie", also match "Amélie"
    if (normQuery !== query.toLowerCase()) {
      const allContacts = await db.select().from(contacts);
      const existingIds = new Set(nameMatches.map((c) => c.id));
      for (const c of allContacts) {
        if (existingIds.has(c.id)) continue;
        const normName = c.displayName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        if (normName.includes(normQuery)) nameMatches.push(c);
      }
    }

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
    try {
      await this.dbService.db.insert(memoryContacts).values({
        id: randomUUID(),
        memoryId,
        contactId,
        role,
      });
    } catch (err: any) {
      // Contact may have been merged/deleted concurrently — skip silently
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return;
      throw err;
    }
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

    // Run the entire merge atomically in a SQLite transaction to prevent
    // race conditions when concurrent embed workers merge the same contacts.
    db.transaction((tx) => {
      const targetRows = tx.select().from(contacts).where(eq(contacts.id, targetId)).all();
      const sourceRows = tx.select().from(contacts).where(eq(contacts.id, sourceId)).all();

      if (!targetRows.length || !sourceRows.length) return; // Either side already merged/deleted — nothing to do

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

      // Move all identifiers from source to target
      tx.update(contactIdentifiers)
        .set({ contactId: targetId })
        .where(eq(contactIdentifiers.contactId, sourceId))
        .run();

      // Deduplicate memoryContacts: delete source rows where target already has the same memoryId+role
      const sourceMemLinks = tx.select().from(memoryContacts)
        .where(eq(memoryContacts.contactId, sourceId)).all();
      const targetMemLinks = tx.select().from(memoryContacts)
        .where(eq(memoryContacts.contactId, targetId)).all();
      const targetMemKeys = new Set(targetMemLinks.map((m) => `${m.memoryId}::${m.role}`));

      for (const link of sourceMemLinks) {
        if (targetMemKeys.has(`${link.memoryId}::${link.role}`)) {
          tx.delete(memoryContacts).where(eq(memoryContacts.id, link.id)).run();
        }
      }

      // Move remaining source memoryContacts to target
      tx.update(memoryContacts)
        .set({ contactId: targetId })
        .where(eq(memoryContacts.contactId, sourceId))
        .run();

      // Update target contact
      tx.update(contacts)
        .set({
          displayName,
          avatars: JSON.stringify(targetAvatars),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contacts.id, targetId))
        .run();

      // Clean up dismissals referencing source
      tx.delete(mergeDismissals)
        .where(
          or(
            eq(mergeDismissals.contactId1, sourceId),
            eq(mergeDismissals.contactId2, sourceId),
          )!,
        )
        .run();

      // Delete source contact — safe now since all children have been moved
      tx.delete(contacts).where(eq(contacts.id, sourceId)).run();
    });

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

    // Load person contacts only — devices/groups should not appear in merge suggestions
    const allContacts = await db.select().from(contacts).where(
      sql`COALESCE(${contacts.entityType}, 'person') = 'person'`,
    );
    const allIdentifiers = await db.select().from(contactIdentifiers);
    const allDismissals = await db.select().from(mergeDismissals);
    const allMemoryContacts = await db.select().from(memoryContacts);

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

    // Build co-occurrence map: contacts that appear in the same memories
    const memoryToContacts = new Map<string, Set<string>>();
    for (const mc of allMemoryContacts) {
      const set = memoryToContacts.get(mc.memoryId) || new Set();
      set.add(mc.contactId);
      memoryToContacts.set(mc.memoryId, set);
    }
    const coOccurrence = new Set<string>();
    for (const [, contactIds] of memoryToContacts) {
      if (contactIds.size < 2) continue;
      const ids = Array.from(contactIds);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          coOccurrence.add([ids[i], ids[j]].sort().join('::'));
        }
      }
    }

    const suggestedPairs = new Set<string>();
    const suggestions: Array<{
      contact1: ContactWithIdentifiers;
      contact2: ContactWithIdentifiers;
      reason: string;
    }> = [];

    const addSuggestion = (c1: typeof allContacts[0], c2: typeof allContacts[0], reason: string) => {
      const pairKey = [c1.id, c2.id].sort().join('::');
      if (dismissedPairs.has(pairKey) || suggestedPairs.has(pairKey)) return;
      suggestedPairs.add(pairKey);

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
        reason,
      });
    };

    // Generic short names that should never trigger merge suggestions
    const GENERIC_NAMES = new Set(['me', 'bot', 'app', 'admin', 'user', 'unknown', 'test', 'info', 'no reply', 'noreply']);

    // Helper: check if two contacts share a non-name identifier
    const shareNonNameIdentifier = (id1: string, id2: string): boolean => {
      const idents1 = contactIdentsMap.get(id1) || [];
      const idents2 = contactIdentsMap.get(id2) || [];
      for (const i1 of idents1) {
        if (i1.identifierType === 'name') continue;
        for (const i2 of idents2) {
          if (i2.identifierType === 'name') continue;
          if (i1.identifierType === i2.identifierType && i1.identifierValue === i2.identifierValue) return true;
        }
      }
      return false;
    };

    for (let i = 0; i < allContacts.length; i++) {
      for (let j = i + 1; j < allContacts.length; j++) {
        const c1 = allContacts[i];
        const c2 = allContacts[j];

        const pairKey = [c1.id, c2.id].sort().join('::');
        if (dismissedPairs.has(pairKey)) continue;

        const nameA = c1.displayName.toLowerCase().trim();
        const nameB = c2.displayName.toLowerCase().trim();
        if (nameA.length < 3 || nameB.length < 3) continue;
        if (GENERIC_NAMES.has(nameA) || GENERIC_NAMES.has(nameB)) continue;

        const connectors1 = contactConnectors.get(c1.id) || new Set();
        const connectors2 = contactConnectors.get(c2.id) || new Set();
        const sameConnector = connectors1.size === 1 && connectors2.size === 1 &&
          [...connectors1][0] === [...connectors2][0];
        const isVisionConnector = sameConnector && [...connectors1][0] === 'photos';

        // Strategy 1: Exact name match — always suggest (even same connector)
        if (nameA === nameB) {
          addSuggestion(c1, c2, `Exact name match: "${c1.displayName}"`);
          continue;
        }

        // Strategy 2: Substring match on displayName
        const shorter = Math.min(nameA.length, nameB.length);
        const longer = Math.max(nameA.length, nameB.length);
        // Raise minimum to 4 chars for substring matching to reduce noise
        if (shorter >= 4 && shorter / longer >= 0.4 && (nameA.includes(nameB) || nameB.includes(nameA))) {
          // Same-connector pairs: only suggest if they share a non-name identifier or co-occur
          if (sameConnector && !isVisionConnector) {
            if (shareNonNameIdentifier(c1.id, c2.id) || coOccurrence.has(pairKey)) {
              addSuggestion(c1, c2, `Display names match: "${c1.displayName}" and "${c2.displayName}"`);
            }
            continue;
          }
          addSuggestion(c1, c2, `Display names match: "${c1.displayName}" and "${c2.displayName}"`);
          continue;
        }

        // Strategy 3: Shared first name + co-occurrence or shared identifier
        const firstA = nameA.split(/\s+/)[0];
        const firstB = nameB.split(/\s+/)[0];
        if (firstA.length >= 3 && firstA === firstB && !GENERIC_NAMES.has(firstA)) {
          if (shareNonNameIdentifier(c1.id, c2.id)) {
            addSuggestion(c1, c2,
              `Share first name "${firstA}" and a common identifier`);
            continue;
          }
          if (coOccurrence.has(pairKey)) {
            addSuggestion(c1, c2,
              `Share first name "${firstA}" and appear in the same memories`);
            continue;
          }
          if (connectors1.has('photos') && connectors2.has('photos')) {
            addSuggestion(c1, c2,
              `Share first name "${firstA}" and both appear in photos`);
          }
        }
      }
    }

    return suggestions;
  }

  /**
   * Normalize all existing identifiers in the DB: trim, lowercase, reclassify,
   * then deduplicate and merge contacts that now share identifiers.
   */
  async normalizeAll(): Promise<{ normalized: number; deduped: number; merged: number }> {
    const db = this.dbService.db;
    const allIdents = await db.select().from(contactIdentifiers);

    let normalized = 0;
    let deduped = 0;
    let merged = 0;

    // Pass 1: Normalize values and reclassify types
    for (const ident of allIdents) {
      const norm = normalizeIdentifier({
        type: ident.identifierType,
        value: ident.identifierValue,
      });

      if (!norm) {
        // Empty after normalization — delete it
        await db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, ident.id));
        deduped++;
        continue;
      }

      if (norm.type !== ident.identifierType || norm.value !== ident.identifierValue) {
        await db
          .update(contactIdentifiers)
          .set({ identifierType: norm.type, identifierValue: norm.value })
          .where(eq(contactIdentifiers.id, ident.id));
        normalized++;
      }
    }

    // Pass 2: Remove duplicate identifiers (same contact, same type+value)
    const remaining = await db.select().from(contactIdentifiers);
    const seenPerContact = new Map<string, Set<string>>();
    for (const ident of remaining) {
      const key = `${ident.contactId}::${ident.identifierType}::${ident.identifierValue}`;
      const contactSeen = seenPerContact.get(ident.contactId) || new Set();
      if (contactSeen.has(`${ident.identifierType}::${ident.identifierValue}`)) {
        await db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, ident.id));
        deduped++;
      } else {
        contactSeen.add(`${ident.identifierType}::${ident.identifierValue}`);
        seenPerContact.set(ident.contactId, contactSeen);
      }
    }

    // Pass 3: Merge contacts that now share non-name identifiers
    const afterDedup = await db.select().from(contactIdentifiers);
    // Build value → contactIds map (skip name identifiers)
    const valueToContacts = new Map<string, Set<string>>();
    for (const ident of afterDedup) {
      if (ident.identifierType === 'name') continue;
      const key = `${ident.identifierType}::${ident.identifierValue}`;
      const set = valueToContacts.get(key) || new Set();
      set.add(ident.contactId);
      valueToContacts.set(key, set);
    }

    // Merge groups where multiple contacts share an identifier
    const mergedInto = new Map<string, string>(); // sourceId → targetId
    for (const [, contactIds] of valueToContacts) {
      if (contactIds.size <= 1) continue;
      const ids = Array.from(contactIds).filter((id) => !mergedInto.has(id));
      if (ids.length <= 1) continue;

      // Resolve chains: find the ultimate target for each id
      const resolveTarget = (id: string): string => {
        while (mergedInto.has(id)) id = mergedInto.get(id)!;
        return id;
      };
      const targets = [...new Set(ids.map(resolveTarget))];
      if (targets.length <= 1) continue;

      const targetId = targets[0];
      for (const sourceId of targets.slice(1)) {
        await this.mergeContacts(targetId, sourceId);
        mergedInto.set(sourceId, targetId);
        merged++;
      }
    }

    return { normalized, deduped, merged };
  }

  /**
   * Reclassify contacts whose entityType is 'person' by cross-referencing
   * entity data from their linked memories. If a contact's displayName
   * appears as a non-person entity type in linked memories, update
   * the contact's entityType to the most common non-person type found.
   */
  async reclassifyEntityTypes(): Promise<{
    reclassified: number;
    details: Array<{ contactId: string; displayName: string; oldType: string; newType: string }>;
  }> {
    const db = this.dbService.db;
    const NON_PERSON_TYPES = ['organization', 'product', 'location', 'event', 'topic', 'pet', 'group', 'device'];

    // Get all person-typed contacts (including NULL/empty coalesced to person)
    const personContacts = await db
      .select()
      .from(contacts)
      .where(sql`COALESCE(${contacts.entityType}, 'person') = 'person'`);

    const details: Array<{ contactId: string; displayName: string; oldType: string; newType: string }> = [];

    for (const contact of personContacts) {
      // Skip contacts whose displayName is a phone number, Slack ID, or too short
      const name = contact.displayName.trim();
      if (name.length < 2) continue;
      if (/^[+\d\s()-]+$/.test(name)) continue; // Phone numbers
      if (/^u[a-z0-9]{8,}$/i.test(name)) continue; // Slack user IDs

      // Get all memories linked to this contact
      const linkedMemories = await db
        .select({ entities: memories.entities })
        .from(memoryContacts)
        .innerJoin(memories, eq(memoryContacts.memoryId, memories.id))
        .where(eq(memoryContacts.contactId, contact.id));

      // Count ALL entity type occurrences matching this contact's name
      const typeCounts = new Map<string, number>();
      const contactNameLower = contact.displayName.toLowerCase();

      for (const mem of linkedMemories) {
        let entitiesArr: Array<{ value: string; type: string }>;
        try {
          entitiesArr = JSON.parse(mem.entities || '[]');
        } catch {
          continue;
        }
        if (!Array.isArray(entitiesArr)) continue;

        for (const entity of entitiesArr) {
          if (!entity.value || !entity.type) continue;
          if (typeof entity.value !== 'string') continue;
          if (entity.value.toLowerCase() === contactNameLower) {
            typeCounts.set(entity.type, (typeCounts.get(entity.type) || 0) + 1);
          }
        }
      }

      // Only consider non-person types
      const nonPersonCounts = new Map<string, number>();
      for (const [type, count] of typeCounts) {
        if (NON_PERSON_TYPES.includes(type)) {
          nonPersonCounts.set(type, count);
        }
      }
      if (nonPersonCounts.size === 0) continue;

      // Find the most common non-person type
      let bestType = '';
      let bestCount = 0;
      for (const [type, count] of nonPersonCounts) {
        if (count > bestCount) {
          bestType = type;
          bestCount = count;
        }
      }

      // Only reclassify if overwhelmingly non-person:
      // - Zero person-type matches and at least 2 non-person matches, OR
      // - Non-person count >= 3x person count (very strong signal)
      const personCount = typeCounts.get('person') || 0;
      if (personCount === 0 && bestCount < 2) continue;
      if (personCount > 0 && bestCount < personCount * 3) continue;

      // Update the contact
      await db
        .update(contacts)
        .set({ entityType: bestType, updatedAt: new Date().toISOString() })
        .where(eq(contacts.id, contact.id));

      details.push({
        contactId: contact.id,
        displayName: contact.displayName,
        oldType: contact.entityType || 'person',
        newType: bestType,
      });
    }

    return { reclassified: details.length, details };
  }

  async removeIdentifier(contactId: string, identifierId: string): Promise<ContactWithIdentifiers> {
    const db = this.dbService.db;

    // Verify identifier exists and belongs to contact
    const idents = await db.select().from(contactIdentifiers)
      .where(eq(contactIdentifiers.contactId, contactId));

    if (!idents.length) throw new Error(`Contact ${contactId} has no identifiers`);

    const target = idents.find((i) => i.id === identifierId);
    if (!target) throw new Error(`Identifier ${identifierId} does not belong to contact ${contactId}`);

    // Prevent removing last identifier
    if (idents.length <= 1) throw new Error('Cannot remove the last identifier from a contact');

    // Delete the identifier
    await db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId));

    // If removed identifier was name type matching displayName, update display name
    if (target.identifierType === 'name') {
      const contact = await db.select().from(contacts).where(eq(contacts.id, contactId));
      if (contact.length && contact[0].displayName === target.identifierValue) {
        const remaining = idents.filter((i) => i.id !== identifierId);
        const nextName = remaining.find((i) => i.identifierType === 'name');
        const newDisplayName = nextName?.identifierValue || remaining[0]?.identifierValue || 'Unknown';
        await db.update(contacts)
          .set({ displayName: newDisplayName, updatedAt: new Date().toISOString() })
          .where(eq(contacts.id, contactId));
      }
    }

    return this.getById(contactId) as Promise<ContactWithIdentifiers>;
  }

  async splitContact(contactId: string, identifierIds: string[]): Promise<ContactWithIdentifiers> {
    const db = this.dbService.db;

    // Validate source contact exists
    const sourceRows = await db.select().from(contacts).where(eq(contacts.id, contactId));
    if (!sourceRows.length) throw new Error(`Contact ${contactId} not found`);

    // Validate all identifierIds belong to this contact
    const allIdents = await db.select().from(contactIdentifiers)
      .where(eq(contactIdentifiers.contactId, contactId));

    const toMove = allIdents.filter((i) => identifierIds.includes(i.id));
    if (toMove.length !== identifierIds.length) {
      throw new Error('Some identifier IDs do not belong to this contact');
    }

    // Prevent splitting ALL identifiers (source must keep at least one)
    if (toMove.length >= allIdents.length) {
      throw new Error('Cannot split all identifiers — source contact must keep at least one');
    }

    // Create new contact
    const newId = randomUUID();
    const now = new Date().toISOString();
    const nameIdent = toMove.find((i) => i.identifierType === 'name');
    const displayName = nameIdent?.identifierValue || toMove[0]?.identifierValue || 'Unknown';

    await db.insert(contacts).values({
      id: newId,
      displayName,
      entityType: sourceRows[0].entityType || 'person',
      createdAt: now,
      updatedAt: now,
    });

    // Move selected identifiers to new contact
    await db.update(contactIdentifiers)
      .set({ contactId: newId })
      .where(inArray(contactIdentifiers.id, identifierIds));

    return this.getById(newId) as Promise<ContactWithIdentifiers>;
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

  async undismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const db = this.dbService.db;
    const [id1, id2] = [contactId1, contactId2].sort();
    await db.delete(mergeDismissals).where(
      and(eq(mergeDismissals.contactId1, id1), eq(mergeDismissals.contactId2, id2)),
    ).run();
  }

}
