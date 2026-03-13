import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, or, sql, inArray, type SQLWrapper } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  contacts as people,
  contactIdentifiers as personIdentifiers,
  memoryContacts as memoryPeople,
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

export interface PersonWithIdentifiers {
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

/** Generic short names that should never trigger merge suggestions */
export const GENERIC_NAMES = new Set([
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

/** Determine if a name looks like a structured identifier (phone, email, etc.) */
export function looksLikeIdentifier(name: string): boolean {
  const trimmed = name.trim();
  // Phone number: starts with + or digits, mostly digits
  if (/^\+?\d[\d\s\-()]{4,}$/.test(trimmed)) return true;
  // Email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  // Slack/WhatsApp ID patterns (e.g. U0XXXXXXX, @lid)
  if (/^[A-Z]\d{6,}$/.test(trimmed)) return true;
  return false;
}

/** Determine if name is a multi-word real name (first + last) */
export function isMultiWordName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length >= 2 && words.every((w) => w.length >= 2);
}

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    @Inject(forwardRef(() => AccountsService)) private accountsService: AccountsService,
  ) {}

  /** Encrypt a JSONB value (avatars or metadata) with APP_SECRET for at-rest protection. */
  private encryptJsonb(value: unknown): string {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    return this.crypto.encrypt(json)!;
  }

  /** Decrypt a JSONB value. Handles plaintext passthrough (pre-encryption data). */
  private decryptJsonb(value: unknown): unknown {
    if (value == null) return value;
    // If it's a string that looks encrypted (iv:data:tag), decrypt it
    if (typeof value === 'string') {
      const decrypted = this.crypto.decrypt(value);
      if (decrypted && decrypted !== value) {
        try {
          return JSON.parse(decrypted);
        } catch {
          return decrypted;
        }
      }
      // Not encrypted — try parsing as JSON
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    // Already a parsed object (pre-encryption JSONB) — return as-is
    return value;
  }

  async resolvePerson(
    rawIdentifiers: IdentifierInput[],
    entityType?: 'person' | 'group' | 'organization' | 'device',
    userId?: string,
  ): Promise<PersonWithIdentifiers> {
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

    const structuredIdents = identifiers.filter((i) => i.type !== 'name');
    if (structuredIdents.length) {
      // Build OR conditions for all structured identifiers using HMAC blind index
      const orConditions = structuredIdents.map(
        (i) =>
          sql`(${personIdentifiers.identifierType} = ${i.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(i.value)})`,
      );
      const whereClause = userId
        ? and(or(...orConditions), eq(people.userId, userId))
        : or(...orConditions);
      const rows = userId
        ? await this.dbService.withCurrentUser((db) =>
            db
              .select({ personId: personIdentifiers.personId })
              .from(personIdentifiers)
              .innerJoin(people, eq(people.id, personIdentifiers.personId))
              .where(whereClause!),
          )
        : await this.dbService.withCurrentUser((db) =>
            db
              .select({ personId: personIdentifiers.personId })
              .from(personIdentifiers)
              .where(whereClause!),
          );
      for (const row of rows) {
        matchedContactIds.add(row.personId);
      }
    }

    const matchedIds = Array.from(matchedContactIds);
    let personId: string;

    if (matchedIds.length === 0) {
      // Create new contact
      personId = randomUUID();
      const now = new Date();
      const nameIdent = identifiers.find((i) => i.type === 'name');
      const displayName = nameIdent?.value || identifiers[0]?.value || 'Unknown';

      await this.dbService.withCurrentUser((db) =>
        db.insert(people).values({
          id: personId,
          displayName: this.crypto.encrypt(displayName)!,
          displayNameHash: this.crypto.hmac(displayName.toLowerCase()),
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
            `[resolvePerson] deduplicateByExactName failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Our contact may have been merged away — verify it still exists
        const stillExists = await this.dbService.withCurrentUser((db) =>
          db.select({ id: people.id }).from(people).where(eq(people.id, personId)),
        );
        if (!stillExists.length) {
          // Find the winner by display name
          const conditions: (SQLWrapper | undefined)[] = [
            sql`${people.displayNameHash} = ${this.crypto.hmac(displayName.toLowerCase())}`,
          ];
          if (userId) conditions.push(eq(people.userId, userId));
          const winners = await this.dbService.withCurrentUser((db) =>
            db
              .select({ id: people.id })
              .from(people)
              .where(and(...conditions))
              .limit(1),
          );
          if (winners.length) {
            personId = winners[0].id;
          }
        }
      }
    } else if (matchedIds.length === 1) {
      personId = matchedIds[0];
      // Update display name if we now have a better one (e.g. resolved from raw ID)
      const nameIdent = identifiers.find((i) => i.type === 'name');
      if (nameIdent?.value) {
        const existing = await this.dbService.withCurrentUser((db) =>
          db
            .select({ displayName: people.displayName })
            .from(people)
            .where(eq(people.id, personId)),
        );
        const rawName = existing[0]?.displayName || '';
        const currentName = this.crypto.decrypt(rawName) ?? rawName;
        const hasRawId = /\bU[A-Z0-9]{8,}\b/.test(currentName);
        const newHasRawId = /\bU[A-Z0-9]{8,}\b/.test(nameIdent.value);
        // Upgrade display name from phone/raw-id/unknown to a real name
        const isPhoneNumber = /^\+?\d[\d\s-]{5,}$/.test(currentName.trim());
        if ((hasRawId && !newHasRawId) || currentName === 'Unknown' || isPhoneNumber) {
          await this.dbService.withCurrentUser((db) =>
            db
              .update(people)
              .set({
                displayName: this.crypto.encrypt(nameIdent.value)!,
                displayNameHash: this.crypto.hmac(nameIdent.value.toLowerCase()),
                updatedAt: new Date(),
              })
              .where(eq(people.id, personId)),
          );
        }
      }
    } else {
      // Multiple contacts matched — merge them into the first one
      personId = matchedIds[0];
      const otherIds = matchedIds.slice(1);

      for (const otherId of otherIds) {
        try {
          await this.mergePeople(personId, otherId);
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
          db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
        );

        // Compare using HMAC hashes so we can check against encrypted stored values
        const existingKeys = new Set(
          existingIdents.map((e) => `${e.identifierType}::${e.identifierValueHash || ''}`),
        );
        const newIdents = identifiers.filter(
          (i) => !existingKeys.has(`${i.type}::${this.crypto.hmac(i.value)}`),
        );
        if (newIdents.length) {
          const now = new Date();
          await this.dbService.withCurrentUser((db) =>
            db
              .insert(personIdentifiers)
              .values(
                newIdents.map((ident) => ({
                  id: randomUUID(),
                  personId,
                  identifierType: ident.type,
                  identifierValue: this.crypto.encrypt(ident.value)!,
                  identifierValueHash: this.crypto.hmac(ident.value),
                  connectorType: ident.connectorType || null,
                  createdAt: now,
                })),
              )
              .onConflictDoNothing(),
          );
        }
        break; // Success
      } catch (err: unknown) {
        identInsertAttempts++;
        if ((err as { code?: string }).code === '23503' && identInsertAttempts < 3) {
          // Contact was merged/deleted concurrently — find where identifiers went
          const probe = identifiers.find((i) => i.type !== 'name') || identifiers[0];
          if (probe) {
            const rows = await this.dbService.withCurrentUser((db) =>
              db
                .select({ personId: personIdentifiers.personId })
                .from(personIdentifiers)
                .where(
                  sql`${personIdentifiers.identifierType} = ${probe.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(probe.value)}`,
                )
                .limit(1),
            );
            if (rows.length) {
              personId = rows[0].personId;
              continue; // Retry with the new contactId
            }
          }
          // Identifier probe found nothing — fall back to display name lookup
          const nameIdent = identifiers.find((i) => i.type === 'name');
          if (nameIdent) {
            const byName = await this.dbService.withCurrentUser((db) =>
              db
                .select({ id: people.id })
                .from(people)
                .where(
                  sql`${people.displayNameHash} = ${this.crypto.hmac(nameIdent.value.toLowerCase())}`,
                )
                .limit(1),
            );
            if (byName.length) {
              personId = byName[0].id;
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
          .update(people)
          .set({
            displayName: this.crypto.encrypt(nameIdent.value)!,
            displayNameHash: this.crypto.hmac(nameIdent.value.toLowerCase()),
            updatedAt: new Date(),
          })
          .where(eq(people.id, personId)),
      );
    }

    // Update entityType if caller provides a non-person type and contact is currently person-typed
    if (entityType && entityType !== 'person') {
      const current = await this.dbService.withCurrentUser((db) =>
        db.select({ entityType: people.entityType }).from(people).where(eq(people.id, personId)),
      );
      if (current.length && (!current[0].entityType || current[0].entityType === 'person')) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({ entityType, updatedAt: new Date() })
            .where(eq(people.id, personId)),
        );
      }
    }

    // Auto-merge: if any non-name identifier on this contact also belongs to
    // another contact, absorb that contact automatically.
    // Capped at 5 merges per resolve to prevent infinite loops from circular references.
    try {
      const allIdentsForContact = await this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
      );

      const MAX_MERGES_PER_RESOLVE = 5;

      // Find all duplicate contacts in a single query
      const structuredContactIdents = allIdentsForContact.filter(
        (i) => i.identifierType !== 'name',
      );
      let dupeContactIds: string[] = [];
      if (structuredContactIdents.length) {
        const orConds = structuredContactIdents.map(
          (i) =>
            sql`(${personIdentifiers.identifierType} = ${i.identifierType} AND ${personIdentifiers.identifierValueHash} = ${i.identifierValueHash})`,
        );
        const dupeRows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ personId: personIdentifiers.personId })
            .from(personIdentifiers)
            .where(and(or(...orConds), sql`${personIdentifiers.personId} != ${personId}`)),
        );
        dupeContactIds = [...new Set(dupeRows.map((r) => r.personId))];
      }

      let mergeCount = 0;
      for (const dupeId of dupeContactIds) {
        if (mergeCount >= MAX_MERGES_PER_RESOLVE) break;
        await this.mergePeople(personId, dupeId);
        mergeCount++;
      }

      if (mergeCount >= MAX_MERGES_PER_RESOLVE) {
        this.logger.warn(
          `[resolvePerson] hit merge cap (${MAX_MERGES_PER_RESOLVE}) for contact ${personId} — skipping remaining`,
        );
      }
    } catch (err) {
      // Auto-merge is best-effort — don't fail the resolve
      this.logger.debug(
        `[resolvePerson] auto-merge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = await this.getById(personId);
    if (!result) {
      // Contact was deleted by a concurrent merge — it was absorbed into another contact.
      // Find where our identifiers ended up.
      const movedIdent = identifiers.find((i) => i.type !== 'name') || identifiers[0];
      if (movedIdent) {
        const rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ personId: personIdentifiers.personId })
            .from(personIdentifiers)
            .where(
              sql`${personIdentifiers.identifierType} = ${movedIdent.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(movedIdent.value)}`,
            )
            .limit(1),
        );
        if (rows.length) {
          return this.getById(rows[0].personId) as Promise<PersonWithIdentifiers>;
        }
      }
      throw new Error(`Contact ${personId} was deleted during resolution`);
    }
    return result;
  }

  async getById(id: string): Promise<PersonWithIdentifiers | null> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, id)),
    );
    if (!rows.length) return null;

    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, id)),
    );

    return {
      ...rows[0],
      displayName: this.crypto.decrypt(rows[0].displayName) ?? rows[0].displayName,
      avatars: this.decryptJsonb(rows[0].avatars),
      metadata: this.decryptJsonb(rows[0].metadata),
      identifiers: idents.map((i) => ({
        id: i.id,
        identifierType: i.identifierType,
        identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
        connectorType: i.connectorType,
        confidence: i.confidence,
      })),
    };
  }

  /**
   * Check if an identifier is a device-format identifier (e.g., "amr/iphone" from OwnTracks).
   * Device identifiers should not appear in the people list.
   */
  private isDeviceIdentifier(ident: typeof personIdentifiers.$inferSelect): boolean {
    const { identifierType } = ident;
    const identifierValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;

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
  private isDeviceOnlyContact(identifiers: (typeof personIdentifiers.$inferSelect)[]): boolean {
    if (identifiers.length === 0) return false;
    return identifiers.every((i) => this.isDeviceIdentifier(i));
  }

  async list(
    params: { limit?: number; offset?: number; entityType?: string; userId?: string } = {},
  ): Promise<{
    items: PersonWithIdentifiers[];
    total: number;
  }> {
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const conditions: (SQLWrapper | undefined)[] = [];
    if (params.entityType) conditions.push(eq(people.entityType, params.entityType));
    if (params.userId) conditions.push(eq(people.userId, params.userId));
    const where = conditions.length ? and(...conditions) : undefined;

    // Get total count without fetching all rows
    const countResult = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(people)
        .where(where),
    );
    const total = countResult[0].count;

    // Get selfPersonId to pin it first (per-user key, then global fallback)
    let selfPersonId = '';
    if (params.userId) {
      const perUserRow = await this.dbService.withCurrentUser((db) =>
        db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, `selfPersonId:${params.userId}`))
          .limit(1),
      );
      selfPersonId = perUserRow[0]?.value || '';
    }
    if (!selfPersonId) {
      const globalRow = await this.dbService.withCurrentUser((db) =>
        db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, 'selfPersonId'))
          .limit(1),
      );
      selfPersonId = globalRow[0]?.value || '';
    }

    // Paginate: self-contact first, then by cached memory count desc
    const paged = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: people.id,
          displayName: people.displayName,
          entityType: people.entityType,
          avatars: people.avatars,
          metadata: people.metadata,
          memoryCount: people.memoryCount,
          createdAt: people.createdAt,
          updatedAt: people.updatedAt,
        })
        .from(people)
        .where(where)
        .orderBy(
          sql`CASE WHEN ${people.id} = ${selfPersonId} THEN 0 ELSE 1 END`,
          sql`${people.memoryCount} DESC`,
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
      db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, pagedIds)),
    );

    // Group identifiers by contactId
    const identsByContact = new Map<string, typeof allIdents>();
    for (const ident of allIdents) {
      const list = identsByContact.get(ident.personId) || [];
      list.push(ident);
      identsByContact.set(ident.personId, list);
    }

    // Filter out device-only contacts
    const filteredPaged = paged.filter((c) => {
      const idents = identsByContact.get(c.id) || [];
      return !this.isDeviceOnlyContact(idents);
    });

    const items: PersonWithIdentifiers[] = filteredPaged.map((c) => {
      const idents = identsByContact.get(c.id) || [];
      return {
        ...c,
        displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
        avatars: this.decryptJsonb(c.avatars),
        metadata: this.decryptJsonb(c.metadata),
        identifiers: idents.map((i) => ({
          id: i.id,
          identifierType: i.identifierType,
          identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
          connectorType: i.connectorType,
          confidence: i.confidence,
        })),
      };
    });

    return { items, total };
  }

  async search(query: string): Promise<PersonWithIdentifiers[]> {
    const lowerQuery = query.toLowerCase();
    const normQuery = query
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    // Since display names and identifier values are encrypted, we can't use SQL LIKE.
    // Fetch all contacts and filter in-memory after decryption.
    const allContactRows = await this.dbService.withCurrentUser((db) => db.select().from(people));

    const allIdentRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers),
    );

    // Build identifier lookup by contactId
    const identsByContact = new Map<string, typeof allIdentRows>();
    for (const ident of allIdentRows) {
      const list = identsByContact.get(ident.personId) || [];
      list.push(ident);
      identsByContact.set(ident.personId, list);
    }

    const matchedIds = new Set<string>();

    for (const c of allContactRows) {
      const decryptedName = this.crypto.decrypt(c.displayName) ?? c.displayName;
      const lowerName = decryptedName.toLowerCase();
      const normName = decryptedName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      if (lowerName.includes(lowerQuery) || normName.includes(normQuery)) {
        matchedIds.add(c.id);
        continue;
      }

      // Check identifiers
      const idents = identsByContact.get(c.id) || [];
      for (const i of idents) {
        const decryptedValue = this.crypto.decrypt(i.identifierValue) ?? i.identifierValue;
        if (decryptedValue.toLowerCase().includes(lowerQuery)) {
          matchedIds.add(c.id);
          break;
        }
      }
    }

    const results: PersonWithIdentifiers[] = [];
    for (const id of matchedIds) {
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
    personId: string,
    avatar: { url: string; source: string },
    fetchHeaders?: Record<string, string>,
  ): Promise<void> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select({ avatars: people.avatars }).from(people).where(eq(people.id, personId)),
    );
    if (!rows.length) return;

    const existing: Array<{ url: string; source: string }> =
      (this.decryptJsonb(rows[0].avatars) as Array<{ url: string; source: string }>) || [];

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
    const updated =
      avatar.source === 'immich' ? [storedAvatar, ...existing] : [...existing, storedAvatar];

    await this.dbService.withCurrentUser((db) =>
      db
        .update(people)
        .set({ avatars: this.encryptJsonb(updated), updatedAt: new Date() })
        .where(eq(people.id, personId)),
    );
  }

  /**
   * Backfill: download all URL-based avatars and convert to base64 data URIs in-place.
   */
  async backfillAvatarData(): Promise<{ converted: number; failed: number }> {
    const db = this.dbService.db;
    const allContacts = await db
      .select({ id: people.id, avatars: people.avatars })
      .from(people)
      .where(
        sql`${people.avatars} IS NOT NULL AND ${people.avatars}::text != '[]' AND ${people.avatars}::text != '""'`,
      );

    // Build auth headers for Immich
    let immichHeaders: Record<string, string> = {};
    try {
      const allAccounts = await this.accountsService.getAll();
      const photosAccount = allAccounts.find((a) => a.connectorType === 'photos');
      if (photosAccount?.authContext) {
        const auth =
          typeof photosAccount.authContext === 'string'
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
      const avatars =
        (this.decryptJsonb(contact.avatars) as Array<{ url: string; source: string }>) || [];
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
          .update(people)
          .set({ avatars: this.encryptJsonb(updated), updatedAt: new Date() })
          .where(eq(people.id, contact.id));
      }
    }

    return { converted, failed };
  }

  async linkMemory(memoryId: string, personId: string, role: string): Promise<void> {
    try {
      await this.dbService.withCurrentUser((db) =>
        db.insert(memoryPeople).values({
          id: randomUUID(),
          memoryId,
          personId,
          role,
        }),
      );
      // Increment cached memory count
      await this.dbService.withCurrentUser((db) =>
        db
          .update(people)
          .set({ memoryCount: sql`${people.memoryCount} + 1` })
          .where(eq(people.id, personId)),
      );
    } catch (err: unknown) {
      // Contact may have been merged/deleted concurrently — skip silently
      if ((err as { code?: string }).code === '23503') return;
      throw err;
    }
  }

  async getMemories(
    personId: string,
    limit = 50,
    userId?: string,
  ): Promise<Record<string, unknown>[]> {
    const conditions = [eq(memoryPeople.personId, personId)];
    if (userId) {
      // Filter memories to only those belonging to user's accounts
      conditions.push(
        sql`${memories.accountId} IN (SELECT id FROM accounts WHERE user_id = ${userId})`,
      );
    }

    const mems = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories })
        .from(memoryPeople)
        .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
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
    T extends {
      text: string;
      entities: string;
      claims: string;
      metadata: string;
      keyVersion?: number;
    },
  >(mem: T, userId?: string, userKey?: Buffer | null): T {
    const kv = mem.keyVersion ?? 0;
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

  async updatePerson(
    id: string,
    updates: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PersonWithIdentifiers | null> {
    // Check contact exists
    const existing = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, id)),
    );
    if (!existing.length) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.displayName !== undefined) {
      patch.displayName = this.crypto.encrypt(updates.displayName)!;
      patch.displayNameHash = this.crypto.hmac(updates.displayName.toLowerCase());
    }
    if (updates.avatars !== undefined) patch.avatars = this.encryptJsonb(updates.avatars);
    if (updates.metadata !== undefined) patch.metadata = this.encryptJsonb(updates.metadata);

    await this.dbService.withCurrentUser((db) =>
      db.update(people).set(patch).where(eq(people.id, id)),
    );

    return this.getById(id);
  }

  async mergePeople(targetId: string, sourceId: string): Promise<PersonWithIdentifiers> {
    // Retry on deadlock up to 3 times
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.dbService.withCurrentUser(
          async (db) =>
            await db.transaction(async (tx) => {
              const targetRows = await tx.select().from(people).where(eq(people.id, targetId));
              const sourceRows = await tx.select().from(people).where(eq(people.id, sourceId));

              if (!targetRows.length || !sourceRows.length) return; // Either side already merged/deleted -- nothing to do

              const target = targetRows[0];
              const source = sourceRows[0];

              // Merge avatars (target first, then source, dedup by url)
              const targetAvatars: Array<{ url: string; source: string }> =
                (this.decryptJsonb(target.avatars) as Array<{ url: string; source: string }>) || [];
              const sourceAvatars: Array<{ url: string; source: string }> =
                (this.decryptJsonb(source.avatars) as Array<{ url: string; source: string }>) || [];
              const seenUrls = new Set(targetAvatars.map((a) => a.url));
              for (const avatar of sourceAvatars) {
                if (!seenUrls.has(avatar.url)) {
                  targetAvatars.push(avatar);
                  seenUrls.add(avatar.url);
                }
              }

              // Prefer a real name over phone numbers / raw IDs
              // Decrypt display names for comparison
              const decryptedSourceName =
                this.crypto.decrypt(source.displayName) ?? source.displayName;
              const decryptedTargetName =
                this.crypto.decrypt(target.displayName) ?? target.displayName;
              const isPhone = (s: string) => /^\+?\d[\d\s-]{5,}$/.test(s.trim());
              const isRawId = (s: string) => /\bU[A-Z0-9]{8,}\b/.test(s);
              const sourceIsName =
                !isPhone(decryptedSourceName) &&
                !isRawId(decryptedSourceName) &&
                decryptedSourceName !== 'Unknown';
              const targetIsName =
                !isPhone(decryptedTargetName) &&
                !isRawId(decryptedTargetName) &&
                decryptedTargetName !== 'Unknown';
              let chosenName: string;
              if (sourceIsName && !targetIsName) {
                chosenName = decryptedSourceName;
              } else if (targetIsName && !sourceIsName) {
                chosenName = decryptedTargetName;
              } else {
                // Both are names or both aren't — keep the longer one
                chosenName =
                  decryptedSourceName.length > decryptedTargetName.length
                    ? decryptedSourceName
                    : decryptedTargetName;
              }
              // Re-encrypt the chosen name for storage
              const displayName = this.crypto.encrypt(chosenName)!;
              const displayNameHash = this.crypto.hmac(chosenName.toLowerCase());

              // Move identifiers from source to target, skipping duplicates
              const sourceIds = await tx
                .select()
                .from(personIdentifiers)
                .where(eq(personIdentifiers.personId, sourceId));
              const targetIds = await tx
                .select()
                .from(personIdentifiers)
                .where(eq(personIdentifiers.personId, targetId));
              const targetIdKeys = new Set(
                targetIds.map((i) => `${i.identifierType}::${i.identifierValueHash || ''}`),
              );
              const dupeIdentIds = sourceIds
                .filter((i) =>
                  targetIdKeys.has(`${i.identifierType}::${i.identifierValueHash || ''}`),
                )
                .map((i) => i.id);
              const moveIdentIds = sourceIds
                .filter(
                  (i) => !targetIdKeys.has(`${i.identifierType}::${i.identifierValueHash || ''}`),
                )
                .map((i) => i.id);
              if (dupeIdentIds.length) {
                await tx
                  .delete(personIdentifiers)
                  .where(inArray(personIdentifiers.id, dupeIdentIds));
              }
              if (moveIdentIds.length) {
                await tx
                  .update(personIdentifiers)
                  .set({ personId: targetId })
                  .where(inArray(personIdentifiers.id, moveIdentIds));
              }

              // Deduplicate memoryPeople: delete source rows where target already has the same memoryId+role
              const sourceMemLinks = await tx
                .select()
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, sourceId));
              const targetMemLinks = await tx
                .select()
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, targetId));
              const targetMemKeys = new Set(targetMemLinks.map((m) => `${m.memoryId}::${m.role}`));

              const dupeMemLinkIds = sourceMemLinks
                .filter((m) => targetMemKeys.has(`${m.memoryId}::${m.role}`))
                .map((m) => m.id);
              if (dupeMemLinkIds.length) {
                await tx.delete(memoryPeople).where(inArray(memoryPeople.id, dupeMemLinkIds));
              }

              // Move remaining source memoryPeople to target
              await tx
                .update(memoryPeople)
                .set({ personId: targetId })
                .where(eq(memoryPeople.personId, sourceId));

              // Recompute target memory count after link moves
              const [{ count: newMemCount }] = await tx
                .select({ count: sql<number>`count(*)` })
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, targetId));

              // Update target contact
              await tx
                .update(people)
                .set({
                  displayName,
                  displayNameHash,
                  avatars: this.encryptJsonb(targetAvatars),
                  memoryCount: newMemCount,
                  updatedAt: new Date(),
                })
                .where(eq(people.id, targetId));

              // Clean up dismissals referencing source
              await tx
                .delete(mergeDismissals)
                .where(
                  or(
                    eq(mergeDismissals.personId1, sourceId),
                    eq(mergeDismissals.personId2, sourceId),
                  )!,
                );

              // Delete any remaining children (race condition: concurrent workers may have added new ones)
              await tx.delete(personIdentifiers).where(eq(personIdentifiers.personId, sourceId));
              await tx.delete(memoryPeople).where(eq(memoryPeople.personId, sourceId));

              // Delete source contact
              await tx.delete(people).where(eq(people.id, sourceId));
            }),
        );
        // Success — return
        return this.getById(targetId) as Promise<PersonWithIdentifiers>;
      } catch (err: unknown) {
        lastError = err;
        // Deadlock (40P01) or FK violation (23503) from concurrent inserts — retry
        if (
          ((err as { code?: string }).code === '40P01' ||
            (err as { code?: string }).code === '23503') &&
          attempt < 3
        ) {
          // Wait a small amount before retrying
          await new Promise((r) => setTimeout(r, Math.random() * 100 + 50 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async deletePerson(id: string): Promise<void> {
    await this.dbService.withCurrentUser(async (db) => {
      await db.delete(memoryPeople).where(eq(memoryPeople.personId, id));
      await db.delete(personIdentifiers).where(eq(personIdentifiers.personId, id));
      await db
        .delete(mergeDismissals)
        .where(or(eq(mergeDismissals.personId1, id), eq(mergeDismissals.personId2, id))!);
      await db.delete(people).where(eq(people.id, id));
    });
  }

  async getSuggestions(userId?: string): Promise<
    Array<{
      contact1: PersonWithIdentifiers;
      contact2: PersonWithIdentifiers;
      reason: string;
    }>
  > {
    // Load contacts — filter by userId if provided, decrypt display names
    const rawContacts = await this.dbService.withCurrentUser((db) =>
      userId ? db.select().from(people).where(eq(people.userId, userId)) : db.select().from(people),
    );
    const allContacts = rawContacts.map((c) => ({
      ...c,
      displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
    }));

    // Scope identifiers, dismissals, and memory links to this user's contacts
    const contactIds = allContacts.map((c) => c.id);
    if (contactIds.length === 0) return [];

    // Run all 3 queries in parallel
    const [allIdentifiers, allDismissals, allMemoryContacts] = await Promise.all([
      this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, contactIds)),
      ),
      this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(mergeDismissals)
          .where(
            or(
              inArray(mergeDismissals.personId1, contactIds),
              inArray(mergeDismissals.personId2, contactIds),
            )!,
          ),
      ),
      this.dbService.withCurrentUser((db) =>
        db.select().from(memoryPeople).where(inArray(memoryPeople.personId, contactIds)),
      ),
    ]);

    // Build contact -> connector types map
    const contactConnectors = new Map<string, Set<string>>();
    for (const ident of allIdentifiers) {
      if (ident.connectorType) {
        const set = contactConnectors.get(ident.personId) || new Set();
        set.add(ident.connectorType);
        contactConnectors.set(ident.personId, set);
      }
    }

    // Build dismissed pairs set (sorted id pair as key)
    const dismissedPairs = new Set<string>();
    for (const d of allDismissals) {
      const key = [d.personId1, d.personId2].sort().join('::');
      dismissedPairs.add(key);
    }

    // Build identifiers map for quick lookup
    const contactIdentsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = contactIdentsMap.get(ident.personId) || [];
      list.push(ident);
      contactIdentsMap.set(ident.personId, list);
    }

    // Build co-occurrence map: contacts that appear in the same memories
    const memoryToContacts = new Map<string, Set<string>>();
    for (const mc of allMemoryContacts) {
      const set = memoryToContacts.get(mc.memoryId) || new Set();
      set.add(mc.personId);
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
      contact1: PersonWithIdentifiers;
      contact2: PersonWithIdentifiers;
      reason: string;
    }> = [];

    // Track contacts that were auto-merged (absorbed into another)
    const mergedAway = new Set<string>();

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
            identifierValue: this.crypto.decrypt(id.identifierValue) ?? id.identifierValue,
            connectorType: id.connectorType,
            confidence: id.confidence,
          })),
        },
        contact2: {
          ...c2,
          identifiers: idents2.map((id) => ({
            id: id.id,
            identifierType: id.identifierType,
            identifierValue: this.crypto.decrypt(id.identifierValue) ?? id.identifierValue,
            connectorType: id.connectorType,
            confidence: id.confidence,
          })),
        },
        reason,
      });
    };

    // GENERIC_NAMES is exported at module level

    // Helper: check if two contacts share a non-name identifier
    const shareNonNameIdentifier = (id1: string, id2: string): boolean => {
      const idents1 = contactIdentsMap.get(id1) || [];
      const idents2 = contactIdentsMap.get(id2) || [];
      for (const i1 of idents1) {
        if (i1.identifierType === 'name') continue;
        for (const i2 of idents2) {
          if (i2.identifierType === 'name') continue;
          if (
            i1.identifierType === i2.identifierType &&
            i1.identifierValueHash === i2.identifierValueHash
          )
            return true;
        }
      }
      return false;
    };

    // Helper: auto-merge c2 (source) into c1 (target)
    const tryAutoMerge = async (
      target: (typeof allContacts)[0],
      source: (typeof allContacts)[0],
      reason: string,
    ): Promise<boolean> => {
      if (mergedAway.has(target.id) || mergedAway.has(source.id)) return true;
      try {
        await this.mergePeople(target.id, source.id);
        mergedAway.add(source.id);
        this.logger.log(`[getSuggestions] auto-merged ${source.id} → ${target.id}: ${reason}`);
        return true;
      } catch (err) {
        this.logger.warn(
          `[getSuggestions] auto-merge failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    };

    // looksLikeIdentifier and isMultiWordName are exported module-level functions

    // Index contacts by first word and full name to avoid O(n²)
    const byExactName = new Map<string, typeof allContacts>();
    const byFirstWord = new Map<string, typeof allContacts>();
    for (const c of allContacts) {
      const name = c.displayName.toLowerCase().trim();
      if (name.length < 3 || GENERIC_NAMES.has(name)) continue;
      const list = byExactName.get(name) || [];
      list.push(c);
      byExactName.set(name, list);

      const first = name.split(/\s+/)[0];
      if (first.length >= 3 && !GENERIC_NAMES.has(first)) {
        const fList = byFirstWord.get(first) || [];
        fList.push(c);
        byFirstWord.set(first, fList);
      }
    }

    // --- Phase 1: Auto-merge obvious exact-name groups before generating suggestions ---
    // For each group of contacts with the exact same display name, auto-merge when:
    //   - Name looks like an identifier (phone/email) → always merge all into one
    //   - Name is a multi-word name (first+last) → merge all into one
    //   - All members share a non-name identifier → merge all into one
    for (const [name, group] of byExactName) {
      if (group.length < 2) continue;

      // Check if any pair in the group was user-dismissed — if so, skip auto-merge for the group
      let anyDismissed = false;
      for (let i = 0; i < group.length && !anyDismissed; i++) {
        for (let j = i + 1; j < group.length && !anyDismissed; j++) {
          const pk = [group[i].id, group[j].id].sort().join('::');
          if (dismissedPairs.has(pk)) anyDismissed = true;
        }
      }
      if (anyDismissed) continue;

      // Check if all members share at least one non-name identifier with the first member
      const allShareIdentifier =
        group.length <= 10 &&
        group.slice(1).every((c) => shareNonNameIdentifier(group[0].id, c.id));

      const shouldAutoMerge =
        looksLikeIdentifier(name) || // phone number, email, etc.
        isMultiWordName(name) || // "John Smith" — unambiguous full name
        allShareIdentifier; // all share a phone/email/handle

      if (shouldAutoMerge) {
        // Pick the one with the most identifiers as the merge target
        const sorted = [...group].sort((a, b) => {
          const aCount = (contactIdentsMap.get(a.id) || []).length;
          const bCount = (contactIdentsMap.get(b.id) || []).length;
          return bCount - aCount;
        });
        const target = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          await tryAutoMerge(target, sorted[i], `Exact name match (auto): "${name}"`);
        }
      }
    }

    // --- Phase 2: Generate suggestions for remaining (ambiguous) pairs ---
    const comparePair = (c1: (typeof allContacts)[0], c2: (typeof allContacts)[0]) => {
      if (mergedAway.has(c1.id) || mergedAway.has(c2.id)) return;
      const pairKey = [c1.id, c2.id].sort().join('::');
      if (dismissedPairs.has(pairKey) || suggestedPairs.has(pairKey)) return;

      const nameA = c1.displayName.toLowerCase().trim();
      const nameB = c2.displayName.toLowerCase().trim();
      const wordsA = nameA.split(/\s+/);
      const wordsB = nameB.split(/\s+/);

      // Never suggest merges based purely on single-word names (too ambiguous)
      // unless they share a non-name identifier (phone/email/handle)
      const bothSingleWord = wordsA.length === 1 && wordsB.length === 1;
      if (bothSingleWord && !looksLikeIdentifier(nameA) && !shareNonNameIdentifier(c1.id, c2.id)) {
        return;
      }

      const connectors1 = contactConnectors.get(c1.id) || new Set();
      const connectors2 = contactConnectors.get(c2.id) || new Set();
      const sameConnector =
        connectors1.size === 1 &&
        connectors2.size === 1 &&
        [...connectors1][0] === [...connectors2][0];
      const isVisionConnector = sameConnector && [...connectors1][0] === 'photos';

      // Strategy 1: Exact name match (not auto-merged — e.g. 3+ way conflict)
      if (nameA === nameB) {
        addSuggestion(c1, c2, `Exact name match: "${c1.displayName}"`);
        return;
      }

      // Strategy 2: Substring / word matching
      const shorter = Math.min(nameA.length, nameB.length);
      const longer = Math.max(nameA.length, nameB.length);

      let wordMatch = false;
      if (wordsA.length === 1 && wordsB.length > 1) {
        wordMatch = wordsB[0] === nameA || wordsB[wordsB.length - 1] === nameA;
      } else if (wordsB.length === 1 && wordsA.length > 1) {
        wordMatch = wordsA[0] === nameB || wordsA[wordsA.length - 1] === nameB;
      }

      if (
        wordMatch ||
        (shorter >= 4 &&
          shorter / longer >= 0.4 &&
          (nameA.includes(nameB) || nameB.includes(nameA)))
      ) {
        if (sameConnector && !isVisionConnector) {
          if (shareNonNameIdentifier(c1.id, c2.id) || coOccurrence.has(pairKey)) {
            addSuggestion(
              c1,
              c2,
              `Display names match: "${c1.displayName}" and "${c2.displayName}"`,
            );
          }
          return;
        }
        addSuggestion(c1, c2, `Display names match: "${c1.displayName}" and "${c2.displayName}"`);
        return;
      }

      // Strategy 3: Shared first name + co-occurrence or shared identifier
      // Skip when both have multi-word names with different last names — they're different people
      const firstA = wordsA[0];
      const firstB = wordsB[0];
      if (firstA.length >= 3 && firstA === firstB && !GENERIC_NAMES.has(firstA)) {
        if (wordsA.length > 1 && wordsB.length > 1) {
          const lastA = wordsA[wordsA.length - 1];
          const lastB = wordsB[wordsB.length - 1];
          if (lastA !== lastB) return;
        }
        if (shareNonNameIdentifier(c1.id, c2.id)) {
          addSuggestion(c1, c2, `Share first name "${firstA}" and a common identifier`);
          return;
        }
        if (coOccurrence.has(pairKey)) {
          addSuggestion(c1, c2, `Share first name "${firstA}" and appear in the same memories`);
          return;
        }
        if (connectors1.has('photos') && connectors2.has('photos')) {
          addSuggestion(c1, c2, `Share first name "${firstA}" and both appear in photos`);
        }
      }
    };

    // Compare only contacts sharing a first word (not all pairs)
    for (const [, group] of byFirstWord) {
      const active = group.filter((c) => !mergedAway.has(c.id));
      if (active.length < 2 || active.length > 100) continue;
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          comparePair(active[i], active[j]);
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
      db.select().from(personIdentifiers),
    );

    let normalized = 0;
    let deduped = 0;
    let merged = 0;

    // Pass 1: Normalize values and reclassify types
    for (const ident of allIdents) {
      const decryptedValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;
      const norm = normalizeIdentifier({
        type: ident.identifierType,
        value: decryptedValue,
      });

      if (!norm) {
        // Empty after normalization — delete it
        await this.dbService.withCurrentUser((db) =>
          db.delete(personIdentifiers).where(eq(personIdentifiers.id, ident.id)),
        );
        deduped++;
        continue;
      }

      if (norm.type !== ident.identifierType || norm.value !== decryptedValue) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(personIdentifiers)
            .set({
              identifierType: norm.type,
              identifierValue: this.crypto.encrypt(norm.value)!,
              identifierValueHash: this.crypto.hmac(norm.value),
            })
            .where(eq(personIdentifiers.id, ident.id)),
        );
        normalized++;
      }
    }

    // Pass 2: Remove duplicate identifiers (same contact, same type+hash)
    const remaining = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers),
    );
    const seenPerContact = new Map<string, Set<string>>();
    for (const ident of remaining) {
      const contactSeen = seenPerContact.get(ident.personId) || new Set();
      const dedupKey = `${ident.identifierType}::${ident.identifierValueHash || ''}`;
      if (contactSeen.has(dedupKey)) {
        await this.dbService.withCurrentUser((db) =>
          db.delete(personIdentifiers).where(eq(personIdentifiers.id, ident.id)),
        );
        deduped++;
      } else {
        contactSeen.add(dedupKey);
        seenPerContact.set(ident.personId, contactSeen);
      }
    }

    // Pass 3: Merge contacts that now share non-name identifiers
    const afterDedup = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers),
    );
    // Build value → contactIds map (skip name identifiers) using HMAC hashes
    const valueToContacts = new Map<string, Set<string>>();
    for (const ident of afterDedup) {
      if (ident.identifierType === 'name') continue;
      const key = `${ident.identifierType}::${ident.identifierValueHash || ''}`;
      const set = valueToContacts.get(key) || new Set();
      set.add(ident.personId);
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
        await this.mergePeople(targetId, sourceId);
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
    details: Array<{ personId: string; displayName: string; oldType: string; newType: string }>;
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
        .from(people)
        .where(sql`COALESCE(${people.entityType}, 'person') = 'person'`),
    );

    const details: Array<{
      personId: string;
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
          .from(memoryPeople)
          .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
          .where(eq(memoryPeople.personId, contact.id)),
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
          .update(people)
          .set({ entityType: bestType, updatedAt: new Date() })
          .where(eq(people.id, contact.id)),
      );

      details.push({
        personId: contact.id,
        displayName: contact.displayName,
        oldType: contact.entityType || 'person',
        newType: bestType,
      });
    }

    return { reclassified: details.length, details };
  }

  async removeIdentifier(personId: string, identifierId: string): Promise<PersonWithIdentifiers> {
    // Verify identifier exists and belongs to contact
    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
    );

    if (!idents.length) throw new Error(`Contact ${personId} has no identifiers`);

    const target = idents.find((i) => i.id === identifierId);
    if (!target)
      throw new Error(`Identifier ${identifierId} does not belong to contact ${personId}`);

    // Prevent removing last identifier
    if (idents.length <= 1) throw new Error('Cannot remove the last identifier from a contact');

    // Delete the identifier
    await this.dbService.withCurrentUser((db) =>
      db.delete(personIdentifiers).where(eq(personIdentifiers.id, identifierId)),
    );

    // If removed identifier was name type matching displayName, update display name
    if (target.identifierType === 'name') {
      const contact = await this.dbService.withCurrentUser((db) =>
        db.select().from(people).where(eq(people.id, personId)),
      );
      const decryptedContactName = contact.length
        ? (this.crypto.decrypt(contact[0].displayName) ?? contact[0].displayName)
        : '';
      const decryptedTargetValue =
        this.crypto.decrypt(target.identifierValue) ?? target.identifierValue;
      if (contact.length && decryptedContactName === decryptedTargetValue) {
        const remaining = idents.filter((i) => i.id !== identifierId);
        const nextName = remaining.find((i) => i.identifierType === 'name');
        const decryptedNextName = nextName
          ? (this.crypto.decrypt(nextName.identifierValue) ?? nextName.identifierValue)
          : null;
        const decryptedRemainingFirst = remaining[0]
          ? (this.crypto.decrypt(remaining[0].identifierValue) ?? remaining[0].identifierValue)
          : 'Unknown';
        const newDisplayName = decryptedNextName || decryptedRemainingFirst;
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({
              displayName: this.crypto.encrypt(newDisplayName)!,
              displayNameHash: this.crypto.hmac(newDisplayName.toLowerCase()),
              updatedAt: new Date(),
            })
            .where(eq(people.id, personId)),
        );
      }
    }

    return this.getById(personId) as Promise<PersonWithIdentifiers>;
  }

  async splitPerson(personId: string, identifierIds: string[]): Promise<PersonWithIdentifiers> {
    // Validate source contact exists
    const sourceRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, personId)),
    );
    if (!sourceRows.length) throw new Error(`Contact ${personId} not found`);

    // Validate all identifierIds belong to this contact
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
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
    const decryptedName = nameIdent
      ? (this.crypto.decrypt(nameIdent.identifierValue) ?? nameIdent.identifierValue)
      : toMove[0]
        ? (this.crypto.decrypt(toMove[0].identifierValue) ?? toMove[0].identifierValue)
        : 'Unknown';

    await this.dbService.withCurrentUser((db) =>
      db.insert(people).values({
        id: newId,
        displayName: this.crypto.encrypt(decryptedName)!,
        displayNameHash: this.crypto.hmac(decryptedName.toLowerCase()),
        entityType: sourceRows[0].entityType || 'person',
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Move selected identifiers to new contact
    await this.dbService.withCurrentUser((db) =>
      db
        .update(personIdentifiers)
        .set({ personId: newId })
        .where(inArray(personIdentifiers.id, identifierIds)),
    );

    return this.getById(newId) as Promise<PersonWithIdentifiers>;
  }

  /**
   * Find all contacts with exactly the same displayName (case-insensitive) and
   * merge them all into the one with the highest memory count (most recent if tied).
   * Only runs when displayName is a real name (non-empty).
   */
  async deduplicateByExactName(displayName: string, userId?: string): Promise<void> {
    const trimmed = displayName.trim();
    if (!trimmed) return;

    // Find all contacts with this exact display name (case-insensitive) via HMAC hash
    const conditions: (SQLWrapper | undefined)[] = [
      sql`${people.displayNameHash} = ${this.crypto.hmac(trimmed.toLowerCase())}`,
    ];
    if (userId) conditions.push(eq(people.userId, userId));

    const matches = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(people)
        .where(and(...conditions)),
    );

    if (matches.length < 2) return;

    // Pick winner: contact with most memoryPeople rows; break ties by most recent createdAt
    const memCounts = await this.dbService.withCurrentUser((db) =>
      db
        .select({ personId: memoryPeople.personId, count: sql<number>`COUNT(*)` })
        .from(memoryPeople)
        .where(
          inArray(
            memoryPeople.personId,
            matches.map((c) => c.id),
          ),
        )
        .groupBy(memoryPeople.personId),
    );

    const countMap = new Map<string, number>();
    for (const row of memCounts) {
      countMap.set(row.personId, Number(row.count));
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
        await this.mergePeople(winner.id, loser.id);
        this.logger.log(`[deduplicateByExactName] merged ${loser.id} → ${winner.id}`);
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
    const allContacts = await this.dbService.withCurrentUser((db) => db.select().from(people));
    const allIdentifiers = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers),
    );

    // Build contactId -> identifiers map
    const identsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = identsMap.get(ident.personId) || [];
      list.push(ident);
      identsMap.set(ident.personId, list);
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
            await this.mergePeople(target.id, source.id);
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
            await this.mergePeople(target.id, sparse.id);
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
    try {
      await this.dbService.withCurrentUser((db) =>
        db.insert(mergeDismissals).values({
          id: randomUUID(),
          personId1: id1,
          personId2: id2,
          createdAt: new Date(),
        }),
      );
    } catch (err: unknown) {
      // Contact was already merged/deleted — dismissal is moot
      if ((err as { code?: string }).code === '23503') return;
      throw err;
    }
  }

  async undismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const [id1, id2] = [contactId1, contactId2].sort();
    await this.dbService.withCurrentUser((db) =>
      db
        .delete(mergeDismissals)
        .where(and(eq(mergeDismissals.personId1, id1), eq(mergeDismissals.personId2, id2))),
    );
  }
}
