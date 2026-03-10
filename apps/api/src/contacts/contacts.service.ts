import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, or, sql, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  contacts,
  contactIdentifiers,
  memoryContacts,
  memories,
  mergeDismissals,
  settings,
} from '../db/schema';

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
      value = value
        .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
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
  avatars: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
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
  private readonly logger = new Logger(ContactsService.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    @Inject(forwardRef(() => AccountsService)) private accountsService: AccountsService,
  ) {}

  async resolveContact(
    rawIdentifiers: IdentifierInput[],
    entityType?: 'person' | 'group' | 'organization' | 'device',
    userId?: string,
  ): Promise<ContactWithIdentifiers> {
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
      // Scope to same-user contacts to prevent cross-user merging
      let rows;
      if (userId) {
        rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ contactId: contactIdentifiers.contactId })
            .from(contactIdentifiers)
            .innerJoin(contacts, eq(contacts.id, contactIdentifiers.contactId))
            .where(
              and(
                sql`${contactIdentifiers.identifierType} = ${ident.type} AND ${contactIdentifiers.identifierValue} = ${ident.value}`,
                eq(contacts.userId, userId),
              ),
            ),
        );
      } else {
        rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ contactId: contactIdentifiers.contactId })
            .from(contactIdentifiers)
            .where(
              sql`${contactIdentifiers.identifierType} = ${ident.type} AND ${contactIdentifiers.identifierValue} = ${ident.value}`,
            ),
        );
      }
      for (const row of rows) {
        matchedContactIds.add(row.contactId);
      }
    }

    const matchedIds = Array.from(matchedContactIds);
    let contactId: string;

    if (matchedIds.length === 0) {
      // Create new contact
      contactId = randomUUID();
      const now = new Date();
      const nameIdent = identifiers.find((i) => i.type === 'name');
      const displayName = nameIdent?.value || identifiers[0]?.value || 'Unknown';

      await this.dbService.withCurrentUser((db) =>
        db.insert(contacts).values({
          id: contactId,
          displayName,
          entityType: entityType || 'person',
          userId: userId || null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      // Auto-merge: deduplicate contacts with the exact same display name
      if (displayName && displayName !== 'Unknown') {
        try {
          await this.deduplicateByExactName(displayName, userId);
        } catch (err) {
          this.logger.warn(
            `[resolveContact] deduplicateByExactName failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Our contact may have been merged away — verify it still exists
        const stillExists = await this.dbService.withCurrentUser((db) =>
          db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)),
        );
        if (!stillExists.length) {
          // Find the winner by display name
          const conditions: any[] = [sql`LOWER(${contacts.displayName}) = LOWER(${displayName})`];
          if (userId) conditions.push(eq(contacts.userId, userId));
          const winners = await this.dbService.withCurrentUser((db) =>
            db
              .select({ id: contacts.id })
              .from(contacts)
              .where(and(...conditions))
              .limit(1),
          );
          if (winners.length) {
            contactId = winners[0].id;
          }
        }
      }
    } else if (matchedIds.length === 1) {
      contactId = matchedIds[0];
      // Update display name if we now have a better one (e.g. resolved from raw ID)
      const nameIdent = identifiers.find((i) => i.type === 'name');
      if (nameIdent?.value) {
        const existing = await this.dbService.withCurrentUser((db) =>
          db.select({ displayName: contacts.displayName }).from(contacts).where(eq(contacts.id, contactId)),
        );
        const currentName = existing[0]?.displayName || '';
        const hasRawId = /\bU[A-Z0-9]{8,}\b/.test(currentName);
        const newHasRawId = /\bU[A-Z0-9]{8,}\b/.test(nameIdent.value);
        // Upgrade display name from phone/raw-id/unknown to a real name
        const isPhoneNumber = /^\+?\d[\d\s-]{5,}$/.test(currentName.trim());
        if ((hasRawId && !newHasRawId) || currentName === 'Unknown' || isPhoneNumber) {
          await this.dbService.withCurrentUser((db) =>
            db.update(contacts).set({ displayName: nameIdent.value, updatedAt: new Date() }).where(eq(contacts.id, contactId)),
          );
        }
      }
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
    let identInsertAttempts = 0;
    while (identInsertAttempts < 3) {
      try {
        const existingIdents = await this.dbService.withCurrentUser((db) =>
          db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, contactId)),
        );

        for (const ident of identifiers) {
          const exists = existingIdents.some(
            (e) => e.identifierType === ident.type && e.identifierValue === ident.value,
          );
          if (!exists) {
            await this.dbService.withCurrentUser((db) =>
              db.insert(contactIdentifiers).values({
                id: randomUUID(),
                contactId,
                identifierType: ident.type,
                identifierValue: ident.value,
                connectorType: ident.connectorType || null,
                createdAt: new Date(),
              }).onConflictDoNothing(),
            );
          }
        }
        break; // Success
      } catch (err: any) {
        identInsertAttempts++;
        if (err?.code === '23503' && identInsertAttempts < 3) {
          // Contact was merged/deleted concurrently — find where identifiers went
          const probe = identifiers.find((i) => i.type !== 'name') || identifiers[0];
          if (probe) {
            const rows = await this.dbService.withCurrentUser((db) =>
              db
                .select({ contactId: contactIdentifiers.contactId })
                .from(contactIdentifiers)
                .where(
                  sql`${contactIdentifiers.identifierType} = ${probe.type} AND ${contactIdentifiers.identifierValue} = ${probe.value}`,
                )
                .limit(1),
            );
            if (rows.length) {
              contactId = rows[0].contactId;
              continue; // Retry with the new contactId
            }
          }
          // Identifier probe found nothing — fall back to display name lookup
          const nameIdent = identifiers.find((i) => i.type === 'name');
          if (nameIdent) {
            const byName = await this.dbService.withCurrentUser((db) =>
              db
                .select({ id: contacts.id })
                .from(contacts)
                .where(sql`LOWER(${contacts.displayName}) = LOWER(${nameIdent.value})`)
                .limit(1),
            );
            if (byName.length) {
              contactId = byName[0].id;
              continue;
            }
          }
        }
        throw err;
      }
    }

    // Update display name if we have a name-type identifier
    const nameIdent = identifiers.find((i) => i.type === 'name');
    if (nameIdent) {
      await this.dbService.withCurrentUser((db) =>
        db
          .update(contacts)
          .set({ displayName: nameIdent.value, updatedAt: new Date() })
          .where(eq(contacts.id, contactId)),
      );
    }

    // Update entityType if caller provides a non-person type and contact is currently person-typed
    if (entityType && entityType !== 'person') {
      const current = await this.dbService.withCurrentUser((db) =>
        db
          .select({ entityType: contacts.entityType })
          .from(contacts)
          .where(eq(contacts.id, contactId)),
      );
      if (current.length && (!current[0].entityType || current[0].entityType === 'person')) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(contacts)
            .set({ entityType, updatedAt: new Date() })
            .where(eq(contacts.id, contactId)),
        );
      }
    }

    // Auto-merge: if any non-name identifier on this contact also belongs to
    // another contact, absorb that contact automatically.
    // Capped at 5 merges per resolve to prevent infinite loops from circular references.
    try {
      const allIdentsForContact = await this.dbService.withCurrentUser((db) =>
        db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, contactId)),
      );

      let mergeCount = 0;
      const MAX_MERGES_PER_RESOLVE = 5;
      const mergedIds = new Set<string>();

      for (const ident of allIdentsForContact) {
        if (mergeCount >= MAX_MERGES_PER_RESOLVE) break;
        if (ident.identifierType === 'name') continue;
        const dupes = await this.dbService.withCurrentUser((db) =>
          db
            .select({ contactId: contactIdentifiers.contactId })
            .from(contactIdentifiers)
            .where(
              sql`${contactIdentifiers.identifierType} = ${ident.identifierType} AND ${contactIdentifiers.identifierValue} = ${ident.identifierValue} AND ${contactIdentifiers.contactId} != ${contactId}`,
            ),
        );

        for (const dupe of dupes) {
          if (mergeCount >= MAX_MERGES_PER_RESOLVE) break;
          if (mergedIds.has(dupe.contactId)) continue;
          mergedIds.add(dupe.contactId);
          await this.mergeContacts(contactId, dupe.contactId);
          mergeCount++;
        }
      }

      if (mergeCount >= MAX_MERGES_PER_RESOLVE) {
        this.logger.warn(
          `[resolveContact] hit merge cap (${MAX_MERGES_PER_RESOLVE}) for contact ${contactId} — skipping remaining`,
        );
      }
    } catch (err) {
      // Auto-merge is best-effort — don't fail the resolve
      this.logger.debug(
        `[resolveContact] auto-merge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = await this.getById(contactId);
    if (!result) {
      // Contact was deleted by a concurrent merge — it was absorbed into another contact.
      // Find where our identifiers ended up.
      const movedIdent = identifiers.find((i) => i.type !== 'name') || identifiers[0];
      if (movedIdent) {
        const rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ contactId: contactIdentifiers.contactId })
            .from(contactIdentifiers)
            .where(
              sql`${contactIdentifiers.identifierType} = ${movedIdent.type} AND ${contactIdentifiers.identifierValue} = ${movedIdent.value}`,
            )
            .limit(1),
        );
        if (rows.length) {
          return this.getById(rows[0].contactId) as Promise<ContactWithIdentifiers>;
        }
      }
      throw new Error(`Contact ${contactId} was deleted during resolution`);
    }
    return result;
  }

  async getById(id: string): Promise<ContactWithIdentifiers | null> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select().from(contacts).where(eq(contacts.id, id)),
    );
    if (!rows.length) return null;

    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, id)),
    );

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

  /**
   * Check if an identifier is a device-format identifier (e.g., "amr/iphone" from OwnTracks).
   * Device identifiers should not appear in the people list.
   */
  private isDeviceIdentifier(ident: typeof contactIdentifiers.$inferSelect): boolean {
    const { identifierType, identifierValue } = ident;

    // OwnTracks device format: 'user/device' (e.g., 'amr/iphone')
    if (identifierType === 'device' && identifierValue.includes('/')) return true;

    // Handle format 'connector:user/device' stored as handle
    if (identifierType === 'handle' && /^[\w]+\/[\w]+$/.test(identifierValue)) {
      // Conservative: could be device format, but also could be legitimate handle
      // Only filter if confidence is very low or from owntracks connector
      return true;
    }

    return false;
  }

  /**
   * Check if a contact is device-only (all identifiers are device identifiers).
   */
  private isDeviceOnlyContact(identifiers: (typeof contactIdentifiers.$inferSelect)[]): boolean {
    if (identifiers.length === 0) return false;
    return identifiers.every((i) => this.isDeviceIdentifier(i));
  }

  async list(
    params: { limit?: number; offset?: number; entityType?: string; userId?: string } = {},
  ): Promise<{
    items: ContactWithIdentifiers[];
    total: number;
  }> {
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const conditions: any[] = [];
    if (params.entityType) conditions.push(eq(contacts.entityType, params.entityType));
    if (params.userId) conditions.push(eq(contacts.userId, params.userId));
    const where = conditions.length ? and(...conditions) : undefined;

    // Get total count without fetching all rows
    const countResult = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(contacts)
        .where(where),
    );
    const total = countResult[0].count;

    // Get selfContactId to pin it first (per-user key, then global fallback)
    let selfContactId = '';
    if (params.userId) {
      const perUserRow = await this.dbService.withCurrentUser((db) =>
        db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, `selfContactId:${params.userId}`))
          .limit(1),
      );
      selfContactId = perUserRow[0]?.value || '';
    }
    if (!selfContactId) {
      const globalRow = await this.dbService.withCurrentUser((db) =>
        db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'selfContactId'))
          .limit(1),
      );
      selfContactId = globalRow[0]?.value || '';
    }

    // Paginate: self-contact first, then by linked memory count desc
    const paged = await this.dbService.withCurrentUser((db) =>
      db
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
        .offset(offset),
    );

    if (paged.length === 0) {
      return { items: [], total };
    }

    // Batch-fetch all identifiers for this page in one query
    const pagedIds = paged.map((c) => c.id);
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers).where(inArray(contactIdentifiers.contactId, pagedIds)),
    );

    // Group identifiers by contactId
    const identsByContact = new Map<string, typeof allIdents>();
    for (const ident of allIdents) {
      const list = identsByContact.get(ident.contactId) || [];
      list.push(ident);
      identsByContact.set(ident.contactId, list);
    }

    // Filter out device-only contacts
    const filteredPaged = paged.filter((c) => {
      const idents = identsByContact.get(c.id) || [];
      return !this.isDeviceOnlyContact(idents);
    });

    const items: ContactWithIdentifiers[] = filteredPaged.map((c) => {
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
    const pattern = `%${query.toLowerCase()}%`;
    const normQuery = query
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    // Search by display name (exact LIKE)
    const nameMatches = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(contacts)
        .where(sql`LOWER(${contacts.displayName}) LIKE ${pattern}`),
    );

    // Accent-stripped fallback: if query is "amelie", also match "Amélie"
    if (normQuery !== query.toLowerCase()) {
      const allContacts = await this.dbService.withCurrentUser((db) => db.select().from(contacts));
      const existingIds = new Set(nameMatches.map((c) => c.id));
      for (const c of allContacts) {
        if (existingIds.has(c.id)) continue;
        const normName = c.displayName
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        if (normName.includes(normQuery)) nameMatches.push(c);
      }
    }

    // Search by identifier value
    const identMatches = await this.dbService.withCurrentUser((db) =>
      db
        .select({ contactId: contactIdentifiers.contactId })
        .from(contactIdentifiers)
        .where(sql`LOWER(${contactIdentifiers.identifierValue}) LIKE ${pattern}`),
    );

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

  /**
   * Download avatar image and store as base64 data URI in the contact's avatars array.
   * Falls back to storing the URL if download fails.
   */
  async updateAvatar(
    contactId: string,
    avatar: { url: string; source: string },
    fetchHeaders?: Record<string, string>,
  ): Promise<void> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select({ avatars: contacts.avatars }).from(contacts).where(eq(contacts.id, contactId)),
    );
    if (!rows.length) return;

    const existing: Array<{ url: string; source: string }> =
      (rows[0].avatars as Array<{ url: string; source: string }>) || [];

    // Skip if we already have an avatar from this source
    if (existing.some((a) => a.source === avatar.source)) return;

    // Download image and convert to data URI
    let storedAvatar = avatar;
    try {
      const res = await fetch(avatar.url, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
        storedAvatar = { url: dataUri, source: avatar.source };
      }
    } catch {
      // Fall back to storing the URL
    }

    // Immich face thumbnails get priority — prepend to front
    const updated = avatar.source === 'immich'
      ? [storedAvatar, ...existing]
      : [...existing, storedAvatar];

    await this.dbService.withCurrentUser((db) =>
      db
        .update(contacts)
        .set({ avatars: updated, updatedAt: new Date() })
        .where(eq(contacts.id, contactId)),
    );
  }

  /**
   * Backfill: download all URL-based avatars and convert to base64 data URIs in-place.
   */
  async backfillAvatarData(): Promise<{ converted: number; failed: number }> {
    const db = this.dbService.db;
    const allContacts = await db
      .select({ id: contacts.id, avatars: contacts.avatars })
      .from(contacts)
      .where(sql`${contacts.avatars} IS NOT NULL AND ${contacts.avatars}::text != '[]'`);

    // Build auth headers for Immich
    let immichHeaders: Record<string, string> = {};
    try {
      const allAccounts = await this.accountsService.getAll();
      const photosAccount = allAccounts.find((a: any) => a.connectorType === 'photos');
      if (photosAccount?.authContext) {
        const auth = typeof photosAccount.authContext === 'string'
          ? JSON.parse(photosAccount.authContext)
          : photosAccount.authContext;
        if (auth?.accessToken) immichHeaders = { 'x-api-key': auth.accessToken };
      }
    } catch {
      // No immich account
    }

    let converted = 0;
    let failed = 0;

    for (const contact of allContacts) {
      const avatars = (contact.avatars as Array<{ url: string; source: string }>) || [];
      if (!avatars.length) continue;

      let changed = false;
      const updated: Array<{ url: string; source: string }> = [];

      for (const avatar of avatars) {
        if (avatar.url.startsWith('data:')) {
          updated.push(avatar);
          continue;
        }

        // Download and convert
        const headers: Record<string, string> = {};
        if (avatar.source === 'immich') Object.assign(headers, immichHeaders);

        try {
          const res = await fetch(avatar.url, { headers, signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const contentType = res.headers.get('content-type') || 'image/jpeg';
            const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
            updated.push({ url: dataUri, source: avatar.source });
            changed = true;
            converted++;
          } else {
            updated.push(avatar); // Keep URL as fallback
            failed++;
          }
        } catch {
          updated.push(avatar);
          failed++;
        }
      }

      if (changed) {
        await db
          .update(contacts)
          .set({ avatars: updated, updatedAt: new Date() })
          .where(eq(contacts.id, contact.id));
      }
    }

    return { converted, failed };
  }

  async linkMemory(memoryId: string, contactId: string, role: string): Promise<void> {
    try {
      await this.dbService.withCurrentUser((db) =>
        db.insert(memoryContacts).values({
          id: randomUUID(),
          memoryId,
          contactId,
          role,
        }),
      );
    } catch (err: any) {
      // Contact may have been merged/deleted concurrently — skip silently
      if (err?.code === '23503') return;
      throw err;
    }
  }

  async getMemories(contactId: string, limit = 50, userId?: string): Promise<any[]> {
    const conditions = [eq(memoryContacts.contactId, contactId)];
    if (userId) {
      // Filter memories to only those belonging to user's accounts
      conditions.push(
        sql`${memories.accountId} IN (SELECT id FROM accounts WHERE user_id = ${userId})`,
      );
    }

    const mems = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories })
        .from(memoryContacts)
        .innerJoin(memories, eq(memoryContacts.memoryId, memories.id))
        .where(and(...conditions))
        .limit(limit),
    );

    let userKey: Buffer | null = null;
    if (userId) {
      userKey = await this.userKeyService.getDek(userId);
    }
    return mems.map((r) => this.decryptMemory(r.memory, userId, userKey));
  }

  private decryptMemory<
    T extends { text: string; entities: string; claims: string; metadata: string; keyVersion?: number },
  >(mem: T, userId?: string, userKey?: Buffer | null): T {
    const kv = (mem as any).keyVersion ?? 0;
    if (kv >= 1 && userId) {
      if (userKey) {
        return this.crypto.decryptMemoryFieldsWithKey(mem, userKey);
      }
      return {
        ...mem,
        text: '[Encrypted — enter your recovery key to view]',
        entities: '[]',
        claims: '[]',
      };
    }
    return this.crypto.decryptMemoryFields(mem);
  }

  async updateContact(
    id: string,
    updates: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ContactWithIdentifiers | null> {
    // Check contact exists
    const existing = await this.dbService.withCurrentUser((db) =>
      db.select().from(contacts).where(eq(contacts.id, id)),
    );
    if (!existing.length) return null;

    const patch: Record<string, any> = { updatedAt: new Date() };
    if (updates.displayName !== undefined) patch.displayName = updates.displayName;
    if (updates.avatars !== undefined) patch.avatars = updates.avatars;
    if (updates.metadata !== undefined) patch.metadata = JSON.stringify(updates.metadata);

    await this.dbService.withCurrentUser((db) =>
      db.update(contacts).set(patch).where(eq(contacts.id, id)),
    );

    return this.getById(id);
  }

  async mergeContacts(targetId: string, sourceId: string): Promise<ContactWithIdentifiers> {
    // Retry on deadlock up to 3 times
    let lastError: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.dbService.withCurrentUser(
          async (db) =>
            await db.transaction(async (tx) => {
              const targetRows = await tx.select().from(contacts).where(eq(contacts.id, targetId));
              const sourceRows = await tx.select().from(contacts).where(eq(contacts.id, sourceId));

              if (!targetRows.length || !sourceRows.length) return; // Either side already merged/deleted -- nothing to do

              const target = targetRows[0];
              const source = sourceRows[0];

              // Merge avatars (target first, then source, dedup by url)
              const targetAvatars: Array<{ url: string; source: string }> =
                (target.avatars as Array<{ url: string; source: string }>) || [];
              const sourceAvatars: Array<{ url: string; source: string }> =
                (source.avatars as Array<{ url: string; source: string }>) || [];
              const seenUrls = new Set(targetAvatars.map((a) => a.url));
              for (const avatar of sourceAvatars) {
                if (!seenUrls.has(avatar.url)) {
                  targetAvatars.push(avatar);
                  seenUrls.add(avatar.url);
                }
              }

              // Prefer a real name over phone numbers / raw IDs
              const isPhone = (s: string) => /^\+?\d[\d\s-]{5,}$/.test(s.trim());
              const isRawId = (s: string) => /\bU[A-Z0-9]{8,}\b/.test(s);
              const sourceIsName = !isPhone(source.displayName) && !isRawId(source.displayName) && source.displayName !== 'Unknown';
              const targetIsName = !isPhone(target.displayName) && !isRawId(target.displayName) && target.displayName !== 'Unknown';
              let displayName: string;
              if (sourceIsName && !targetIsName) {
                displayName = source.displayName;
              } else if (targetIsName && !sourceIsName) {
                displayName = target.displayName;
              } else {
                // Both are names or both aren't — keep the longer one
                displayName = source.displayName.length > target.displayName.length
                  ? source.displayName
                  : target.displayName;
              }

              // Move identifiers from source to target, skipping duplicates
              const sourceIds = await tx
                .select()
                .from(contactIdentifiers)
                .where(eq(contactIdentifiers.contactId, sourceId));
              const targetIds = await tx
                .select()
                .from(contactIdentifiers)
                .where(eq(contactIdentifiers.contactId, targetId));
              const targetIdKeys = new Set(
                targetIds.map((i: any) => `${i.identifierType}::${i.identifierValue}`),
              );
              for (const ident of sourceIds) {
                if (targetIdKeys.has(`${ident.identifierType}::${ident.identifierValue}`)) {
                  await tx.delete(contactIdentifiers).where(eq(contactIdentifiers.id, ident.id));
                } else {
                  await tx
                    .update(contactIdentifiers)
                    .set({ contactId: targetId })
                    .where(eq(contactIdentifiers.id, ident.id));
                }
              }

              // Deduplicate memoryContacts: delete source rows where target already has the same memoryId+role
              const sourceMemLinks = await tx
                .select()
                .from(memoryContacts)
                .where(eq(memoryContacts.contactId, sourceId));
              const targetMemLinks = await tx
                .select()
                .from(memoryContacts)
                .where(eq(memoryContacts.contactId, targetId));
              const targetMemKeys = new Set(
                targetMemLinks.map((m: any) => `${m.memoryId}::${m.role}`),
              );

              for (const link of sourceMemLinks) {
                if (targetMemKeys.has(`${link.memoryId}::${link.role}`)) {
                  await tx.delete(memoryContacts).where(eq(memoryContacts.id, link.id));
                }
              }

              // Move remaining source memoryContacts to target
              await tx
                .update(memoryContacts)
                .set({ contactId: targetId })
                .where(eq(memoryContacts.contactId, sourceId));

              // Update target contact
              await tx
                .update(contacts)
                .set({
                  displayName,
                  avatars: targetAvatars,
                  updatedAt: new Date(),
                })
                .where(eq(contacts.id, targetId));

              // Clean up dismissals referencing source
              await tx
                .delete(mergeDismissals)
                .where(
                  or(
                    eq(mergeDismissals.contactId1, sourceId),
                    eq(mergeDismissals.contactId2, sourceId),
                  )!,
                );

              // Delete any remaining children (race condition: concurrent workers may have added new ones)
              await tx.delete(contactIdentifiers).where(eq(contactIdentifiers.contactId, sourceId));
              await tx.delete(memoryContacts).where(eq(memoryContacts.contactId, sourceId));

              // Delete source contact
              await tx.delete(contacts).where(eq(contacts.id, sourceId));
            }),
        );
        // Success — return
        return this.getById(targetId) as Promise<ContactWithIdentifiers>;
      } catch (err: any) {
        lastError = err;
        // Deadlock (40P01) or FK violation (23503) from concurrent inserts — retry
        if ((err?.code === '40P01' || err?.code === '23503') && attempt < 3) {
          // Wait a small amount before retrying
          await new Promise((r) => setTimeout(r, Math.random() * 100 + 50 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async deleteContact(id: string): Promise<void> {
    await this.dbService.withCurrentUser(async (db) => {
      await db.delete(memoryContacts).where(eq(memoryContacts.contactId, id));
      await db.delete(contactIdentifiers).where(eq(contactIdentifiers.contactId, id));
      await db
        .delete(mergeDismissals)
        .where(or(eq(mergeDismissals.contactId1, id), eq(mergeDismissals.contactId2, id))!);
      await db.delete(contacts).where(eq(contacts.id, id));
    });
  }

  async getSuggestions(userId?: string): Promise<
    Array<{
      contact1: ContactWithIdentifiers;
      contact2: ContactWithIdentifiers;
      reason: string;
    }>
  > {
    // Run auto-merge first to clean up obvious duplicates
    await this.autoMerge();

    // Load contacts — filter by userId if provided
    const allContacts = await this.dbService.withCurrentUser((db) =>
      userId
        ? db.select().from(contacts).where(eq(contacts.userId, userId))
        : db.select().from(contacts),
    );
    const allIdentifiers = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers),
    );
    const allDismissals = await this.dbService.withCurrentUser((db) =>
      db.select().from(mergeDismissals),
    );
    const allMemoryContacts = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryContacts),
    );

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

    const addSuggestion = (
      c1: (typeof allContacts)[0],
      c2: (typeof allContacts)[0],
      reason: string,
    ) => {
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
    const GENERIC_NAMES = new Set([
      'me',
      'bot',
      'app',
      'admin',
      'user',
      'unknown',
      'test',
      'info',
      'no reply',
      'noreply',
    ]);

    // Helper: check if two contacts share a non-name identifier
    const shareNonNameIdentifier = (id1: string, id2: string): boolean => {
      const idents1 = contactIdentsMap.get(id1) || [];
      const idents2 = contactIdentsMap.get(id2) || [];
      for (const i1 of idents1) {
        if (i1.identifierType === 'name') continue;
        for (const i2 of idents2) {
          if (i2.identifierType === 'name') continue;
          if (i1.identifierType === i2.identifierType && i1.identifierValue === i2.identifierValue)
            return true;
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
        const sameConnector =
          connectors1.size === 1 &&
          connectors2.size === 1 &&
          [...connectors1][0] === [...connectors2][0];
        const isVisionConnector = sameConnector && [...connectors1][0] === 'photos';

        // Strategy 1: Exact name match — always suggest (even same connector)
        if (nameA === nameB) {
          addSuggestion(c1, c2, `Exact name match: "${c1.displayName}"`);
          continue;
        }

        // Strategy 2: Substring matching - improved to catch word-level matches
        // Allow "amr" (3 chars) to match "amr essam" because "amr" is a complete word
        const wordsA = nameA.split(/\s+/);
        const wordsB = nameB.split(/\s+/);
        const shorter = Math.min(nameA.length, nameB.length);
        const longer = Math.max(nameA.length, nameB.length);

        // Check if shorter name is a complete word of the longer name
        let wordMatch = false;
        if (wordsA.length === 1 && wordsB.length > 1) {
          // nameA is single word, nameB is multiple words — check if nameA is first/last word of nameB
          wordMatch = wordsB[0] === nameA || wordsB[wordsB.length - 1] === nameA;
        } else if (wordsB.length === 1 && wordsA.length > 1) {
          // nameB is single word, nameA is multiple words
          wordMatch = wordsA[0] === nameB || wordsA[wordsA.length - 1] === nameB;
        }

        if (
          wordMatch ||
          (shorter >= 4 &&
            shorter / longer >= 0.4 &&
            (nameA.includes(nameB) || nameB.includes(nameA)))
        ) {
          // Same-connector pairs: only suggest if they share a non-name identifier or co-occur
          if (sameConnector && !isVisionConnector) {
            if (shareNonNameIdentifier(c1.id, c2.id) || coOccurrence.has(pairKey)) {
              addSuggestion(
                c1,
                c2,
                `Display names match: "${c1.displayName}" and "${c2.displayName}"`,
              );
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
            addSuggestion(c1, c2, `Share first name "${firstA}" and a common identifier`);
            continue;
          }
          if (coOccurrence.has(pairKey)) {
            addSuggestion(c1, c2, `Share first name "${firstA}" and appear in the same memories`);
            continue;
          }
          if (connectors1.has('photos') && connectors2.has('photos')) {
            addSuggestion(c1, c2, `Share first name "${firstA}" and both appear in photos`);
          }
        }

        // Strategy 3.5: 3-char first name with co-occurrence or shared identifier
        // Catch cases like "AMR" + "AMR ESSAM" that co-occur or share identifiers
        if (firstA.length === 3 && firstA === firstB && !GENERIC_NAMES.has(firstA)) {
          if (shareNonNameIdentifier(c1.id, c2.id) || coOccurrence.has(pairKey)) {
            addSuggestion(c1, c2, `Share first name "${firstA}" and have additional connection`);
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
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers),
    );

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
        await this.dbService.withCurrentUser((db) =>
          db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, ident.id)),
        );
        deduped++;
        continue;
      }

      if (norm.type !== ident.identifierType || norm.value !== ident.identifierValue) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(contactIdentifiers)
            .set({ identifierType: norm.type, identifierValue: norm.value })
            .where(eq(contactIdentifiers.id, ident.id)),
        );
        normalized++;
      }
    }

    // Pass 2: Remove duplicate identifiers (same contact, same type+value)
    const remaining = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers),
    );
    const seenPerContact = new Map<string, Set<string>>();
    for (const ident of remaining) {
      const contactSeen = seenPerContact.get(ident.contactId) || new Set();
      if (contactSeen.has(`${ident.identifierType}::${ident.identifierValue}`)) {
        await this.dbService.withCurrentUser((db) =>
          db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, ident.id)),
        );
        deduped++;
      } else {
        contactSeen.add(`${ident.identifierType}::${ident.identifierValue}`);
        seenPerContact.set(ident.contactId, contactSeen);
      }
    }

    // Pass 3: Merge contacts that now share non-name identifiers
    const afterDedup = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers),
    );
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
    const NON_PERSON_TYPES = [
      'organization',
      'product',
      'location',
      'event',
      'topic',
      'pet',
      'group',
      'device',
    ];

    // Get all person-typed contacts (including NULL/empty coalesced to person)
    const personContacts = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(contacts)
        .where(sql`COALESCE(${contacts.entityType}, 'person') = 'person'`),
    );

    const details: Array<{
      contactId: string;
      displayName: string;
      oldType: string;
      newType: string;
    }> = [];

    for (const contact of personContacts) {
      // Skip contacts whose displayName is a phone number, Slack ID, or too short
      const name = contact.displayName.trim();
      if (name.length < 2) continue;
      if (/^[+\d\s()-]+$/.test(name)) continue; // Phone numbers
      if (/^u[a-z0-9]{8,}$/i.test(name)) continue; // Slack user IDs

      // Get all memories linked to this contact
      const linkedMemories = await this.dbService.withCurrentUser((db) =>
        db
          .select({ entities: memories.entities })
          .from(memoryContacts)
          .innerJoin(memories, eq(memoryContacts.memoryId, memories.id))
          .where(eq(memoryContacts.contactId, contact.id)),
      );

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
      await this.dbService.withCurrentUser((db) =>
        db
          .update(contacts)
          .set({ entityType: bestType, updatedAt: new Date() })
          .where(eq(contacts.id, contact.id)),
      );

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
    // Verify identifier exists and belongs to contact
    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, contactId)),
    );

    if (!idents.length) throw new Error(`Contact ${contactId} has no identifiers`);

    const target = idents.find((i) => i.id === identifierId);
    if (!target)
      throw new Error(`Identifier ${identifierId} does not belong to contact ${contactId}`);

    // Prevent removing last identifier
    if (idents.length <= 1) throw new Error('Cannot remove the last identifier from a contact');

    // Delete the identifier
    await this.dbService.withCurrentUser((db) =>
      db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId)),
    );

    // If removed identifier was name type matching displayName, update display name
    if (target.identifierType === 'name') {
      const contact = await this.dbService.withCurrentUser((db) =>
        db.select().from(contacts).where(eq(contacts.id, contactId)),
      );
      if (contact.length && contact[0].displayName === target.identifierValue) {
        const remaining = idents.filter((i) => i.id !== identifierId);
        const nextName = remaining.find((i) => i.identifierType === 'name');
        const newDisplayName =
          nextName?.identifierValue || remaining[0]?.identifierValue || 'Unknown';
        await this.dbService.withCurrentUser((db) =>
          db
            .update(contacts)
            .set({ displayName: newDisplayName, updatedAt: new Date() })
            .where(eq(contacts.id, contactId)),
        );
      }
    }

    return this.getById(contactId) as Promise<ContactWithIdentifiers>;
  }

  async splitContact(contactId: string, identifierIds: string[]): Promise<ContactWithIdentifiers> {
    // Validate source contact exists
    const sourceRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(contacts).where(eq(contacts.id, contactId)),
    );
    if (!sourceRows.length) throw new Error(`Contact ${contactId} not found`);

    // Validate all identifierIds belong to this contact
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers).where(eq(contactIdentifiers.contactId, contactId)),
    );

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
    const now = new Date();
    const nameIdent = toMove.find((i) => i.identifierType === 'name');
    const displayName = nameIdent?.identifierValue || toMove[0]?.identifierValue || 'Unknown';

    await this.dbService.withCurrentUser((db) =>
      db.insert(contacts).values({
        id: newId,
        displayName,
        entityType: sourceRows[0].entityType || 'person',
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Move selected identifiers to new contact
    await this.dbService.withCurrentUser((db) =>
      db
        .update(contactIdentifiers)
        .set({ contactId: newId })
        .where(inArray(contactIdentifiers.id, identifierIds)),
    );

    return this.getById(newId) as Promise<ContactWithIdentifiers>;
  }

  /**
   * Find all contacts with exactly the same displayName (case-insensitive) and
   * merge them all into the one with the highest memory count (most recent if tied).
   * Only runs when displayName is a real name (non-empty).
   */
  async deduplicateByExactName(displayName: string, userId?: string): Promise<void> {
    const trimmed = displayName.trim();
    if (!trimmed) return;

    // Find all contacts with this exact display name (case-insensitive), scoped to user
    const conditions: any[] = [sql`LOWER(${contacts.displayName}) = LOWER(${trimmed})`];
    if (userId) conditions.push(eq(contacts.userId, userId));

    const matches = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(contacts)
        .where(and(...conditions)),
    );

    if (matches.length < 2) return;

    // Pick winner: contact with most memoryContacts rows; break ties by most recent createdAt
    const memCounts = await this.dbService.withCurrentUser((db) =>
      db
        .select({ contactId: memoryContacts.contactId, count: sql<number>`COUNT(*)` })
        .from(memoryContacts)
        .where(
          inArray(
            memoryContacts.contactId,
            matches.map((c) => c.id),
          ),
        )
        .groupBy(memoryContacts.contactId),
    );

    const countMap = new Map<string, number>();
    for (const row of memCounts) {
      countMap.set(row.contactId, Number(row.count));
    }

    matches.sort((a, b) => {
      const countDiff = (countMap.get(b.id) || 0) - (countMap.get(a.id) || 0);
      if (countDiff !== 0) return countDiff;
      // Most recent as tiebreaker
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const winner = matches[0];
    const losers = matches.slice(1);

    for (const loser of losers) {
      try {
        await this.mergeContacts(winner.id, loser.id);
        this.logger.log(
          `[deduplicateByExactName] merged ${loser.id} → ${winner.id}`,
        );
      } catch (err) {
        // Concurrent merge may have already handled this — ignore
        this.logger.warn(
          `[deduplicateByExactName] merge failed for ${loser.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Auto-merge obvious contact duplicates using safety-tiered rules.
   * Tier 1: Non-person exact name matches (organizations, products, etc.)
   * Tier 2: Sparse-to-rich exact name matches (name-only into structured)
   * Tier 3: Person-to-person (skipped — left for manual review)
   */
  async autoMerge(): Promise<{
    merged: number;
    byRule: { nonPerson: number; sparseToRich: number };
    details: Array<{ targetId: string; sourceId: string; targetName: string; rule: string }>;
  }> {
    const NON_PERSON_TYPES = new Set([
      'organization',
      'product',
      'location',
      'event',
      'topic',
      'pet',
      'device',
      'other',
      'group',
    ]);

    // Load all contacts and identifiers in bulk
    const allContacts = await this.dbService.withCurrentUser((db) => db.select().from(contacts));
    const allIdentifiers = await this.dbService.withCurrentUser((db) =>
      db.select().from(contactIdentifiers),
    );

    // Build contactId -> identifiers map
    const identsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = identsMap.get(ident.contactId) || [];
      list.push(ident);
      identsMap.set(ident.contactId, list);
    }

    // Group contacts by normalized display name
    const nameGroups = new Map<string, typeof allContacts>();
    for (const contact of allContacts) {
      const key = contact.displayName.toLowerCase().trim();
      if (!key) continue;
      const group = nameGroups.get(key) || [];
      group.push(contact);
      nameGroups.set(key, group);
    }

    const result = {
      merged: 0,
      byRule: { nonPerson: 0, sparseToRich: 0 },
      details: [] as Array<{
        targetId: string;
        sourceId: string;
        targetName: string;
        rule: string;
      }>,
    };

    // Track merged-away IDs to skip them in later processing
    const mergedAway = new Set<string>();

    for (const [, group] of nameGroups) {
      if (group.length < 2) continue;

      // Filter out already-merged contacts
      let active = group.filter((c) => !mergedAway.has(c.id));
      if (active.length < 2) continue;

      // --- Tier 1: Non-person exact name match ---
      const nonPersonInGroup = active.filter((c) => {
        const entityType = c.entityType || 'person';
        return NON_PERSON_TYPES.has(entityType);
      });

      if (nonPersonInGroup.length >= 2) {
        // Pick the one with the most identifiers as target
        nonPersonInGroup.sort((a, b) => {
          const aCount = (identsMap.get(a.id) || []).length;
          const bCount = (identsMap.get(b.id) || []).length;
          return bCount - aCount;
        });
        const target = nonPersonInGroup[0];
        for (let i = 1; i < nonPersonInGroup.length; i++) {
          const source = nonPersonInGroup[i];
          try {
            await this.mergeContacts(target.id, source.id);
            mergedAway.add(source.id);
            result.merged++;
            result.byRule.nonPerson++;
            result.details.push({
              targetId: target.id,
              sourceId: source.id,
              targetName: target.displayName,
              rule: 'nonPerson',
            });
          } catch {
            // Concurrent merge or already merged — continue
          }
        }
        // Refresh active list after Tier 1
        active = active.filter((c) => !mergedAway.has(c.id));
      }

      if (active.length < 2) continue;

      // --- Tier 2: Sparse-to-rich exact name match ---
      const isSparse = (c: (typeof active)[0]): boolean => {
        const idents = identsMap.get(c.id) || [];
        return idents.every((i) => i.identifierType === 'name');
      };
      const isRich = (c: (typeof active)[0]): boolean => {
        const idents = identsMap.get(c.id) || [];
        return idents.some((i) => i.identifierType !== 'name');
      };

      const sparseContacts = active.filter(isSparse);
      const richContacts = active.filter(isRich);

      if (sparseContacts.length > 0 && richContacts.length === 1) {
        // Exactly one rich contact — merge all sparse into it
        const target = richContacts[0];
        for (const sparse of sparseContacts) {
          try {
            await this.mergeContacts(target.id, sparse.id);
            mergedAway.add(sparse.id);
            result.merged++;
            result.byRule.sparseToRich++;
            result.details.push({
              targetId: target.id,
              sourceId: sparse.id,
              targetName: target.displayName,
              rule: 'sparseToRich',
            });
          } catch {
            // Concurrent merge or already merged — continue
          }
        }
      }
      // If multiple rich contacts match, skip (ambiguous)

      // --- Tier 3: Person-to-person — skip (manual review) ---
    }

    return result;
  }

  async dismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const [id1, id2] = [contactId1, contactId2].sort();
    await this.dbService.withCurrentUser((db) =>
      db.insert(mergeDismissals).values({
        id: randomUUID(),
        contactId1: id1,
        contactId2: id2,
        createdAt: new Date(),
      }),
    );
  }

  async undismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const [id1, id2] = [contactId1, contactId2].sort();
    await this.dbService.withCurrentUser((db) =>
      db
        .delete(mergeDismissals)
        .where(and(eq(mergeDismissals.contactId1, id1), eq(mergeDismissals.contactId2, id2))),
    );
  }
}
