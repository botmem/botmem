import { Injectable } from '@nestjs/common';
import { eq, and, sql, desc, inArray, type SQLWrapper } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { PeopleService } from '../people/people.service';
import {
  accounts,
  people,
  personIdentifiers,
  memoryPeople,
  memories,
  mergeDismissals,
  settings,
  users,
} from '../db/schema';
import { normalizeEmail, normalizePhone } from '../people/people.service';

const SELF_CONTACT_ID_KEY = 'selfContactId';

@Injectable()
export class MeService {
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private contactsService: PeopleService,
  ) {}

  /**
   * Set the "self" contact manually by storing the contact ID in settings.
   */
  async setSelfContact(contactId: string, userId?: string): Promise<{ ok: boolean }> {
    const db = this.dbService.db;

    // Verify the contact exists and belongs to user
    const conditions: SQLWrapper[] = [eq(people.id, contactId)];
    if (userId) conditions.push(eq(people.userId, userId));
    const existing = await db
      .select({ id: people.id })
      .from(people)
      .where(and(...conditions));
    if (!existing.length) {
      throw new Error(`Contact ${contactId} not found`);
    }

    const settingKey = userId ? `${SELF_CONTACT_ID_KEY}:${userId}` : SELF_CONTACT_ID_KEY;
    await db
      .insert(settings)
      .values({ key: settingKey, value: contactId })
      .onConflictDoUpdate({ target: settings.key, set: { value: contactId } });

    return { ok: true };
  }

  /**
   * Auto-detect the self contact by cross-referencing account identifiers
   * with the contact_identifiers table. Returns the contact ID or null.
   */
  private async detectSelfContactId(userId?: string): Promise<string | null> {
    const db = this.dbService.db;

    // Get user's accounts only
    const accountConditions: SQLWrapper[] = [];
    if (userId) accountConditions.push(eq(accounts.userId, userId));
    const allAccounts = await db
      .select()
      .from(accounts)
      .where(accountConditions.length ? and(...accountConditions) : undefined);
    if (!allAccounts.length) return null;

    // Build normalized identifier lookup values from accounts
    const lookups: Array<{ type: string; value: string }> = [];
    for (const acct of allAccounts) {
      const identifier = acct.identifier;
      if (!identifier) continue;

      switch (acct.connectorType) {
        case 'gmail': {
          lookups.push({ type: 'email', value: normalizeEmail(identifier) });
          break;
        }
        case 'whatsapp': {
          lookups.push({ type: 'phone', value: normalizePhone(identifier) });
          break;
        }
        case 'slack': {
          // identifier is username@workspace or similar
          lookups.push({ type: 'slack_id', value: identifier.toLowerCase() });
          break;
        }
        case 'imessage': {
          lookups.push({ type: 'imessage_handle', value: identifier.toLowerCase() });
          // Could also be email or phone
          if (identifier.includes('@')) {
            lookups.push({ type: 'email', value: normalizeEmail(identifier) });
          } else {
            lookups.push({ type: 'phone', value: normalizePhone(identifier) });
          }
          break;
        }
        default: {
          // Generic: try email if it looks like one, otherwise use as-is
          if (identifier.includes('@')) {
            lookups.push({ type: 'email', value: normalizeEmail(identifier) });
          }
          break;
        }
      }
    }

    if (!lookups.length) return null;

    // Find contacts matching any of these identifiers (use HMAC blind index)
    const contactIdCounts = new Map<string, number>();
    for (const lookup of lookups) {
      const hash = this.crypto.hmac(lookup.value);
      const rows = await db
        .select({ personId: personIdentifiers.personId })
        .from(personIdentifiers)
        .where(
          sql`${personIdentifiers.identifierType} = ${lookup.type} AND ${personIdentifiers.identifierValueHash} = ${hash}`,
        );
      for (const row of rows) {
        contactIdCounts.set(row.personId, (contactIdCounts.get(row.personId) || 0) + 1);
      }
    }

    if (!contactIdCounts.size) return null;

    // Return the contact with the most identifier matches
    let bestId = '';
    let bestCount = 0;
    for (const [id, count] of contactIdCounts) {
      if (count > bestCount) {
        bestId = id;
        bestCount = count;
      }
    }

    return bestId || null;
  }

  /**
   * Resolve the self contact ID: manual override first, then auto-detect.
   */
  private async resolveSelfContactId(userId?: string): Promise<string | null> {
    const db = this.dbService.db;

    // Check per-user manual override first, then global fallback
    const settingKey = userId ? `${SELF_CONTACT_ID_KEY}:${userId}` : SELF_CONTACT_ID_KEY;
    let [row] = await db.select().from(settings).where(eq(settings.key, settingKey));
    if (!row && userId) {
      [row] = await db.select().from(settings).where(eq(settings.key, SELF_CONTACT_ID_KEY));
    }

    if (row?.value) {
      // Verify it still exists (and belongs to user if userId given)
      const conditions: SQLWrapper[] = [eq(people.id, row.value)];
      if (userId) conditions.push(eq(people.userId, userId));
      const exists = await db
        .select({ id: people.id })
        .from(people)
        .where(and(...conditions));
      if (exists.length) return row.value;
    }

    // Auto-detect
    return this.detectSelfContactId(userId);
  }

  /**
   * Set which avatar index is the "preferred" (primary display) avatar.
   */
  async setPreferredAvatar(userId: string, avatarIndex: number): Promise<{ ok: boolean }> {
    const selfContactId = await this.resolveSelfContactId(userId);
    if (!selfContactId) {
      throw new Error('Self contact not set');
    }
    await this.dbService.db
      .update(people)
      .set({ preferredAvatarIndex: avatarIndex, updatedAt: new Date() })
      .where(eq(people.id, selfContactId));
    return { ok: true };
  }

  /**
   * Lightweight check: is the "me" identity set?
   */
  async getStatus(userId?: string): Promise<{ isSet: boolean; contactId: string | null }> {
    const contactId = await this.resolveSelfContactId(userId);
    return { isSet: !!contactId, contactId };
  }

  /**
   * Find contacts that look like duplicates of "me" — candidates for merge.
   * Uses same heuristics as merge suggestions: name substring match + shared identifiers.
   */
  async getMergeCandidates(userId?: string): Promise<
    Array<{
      id: string;
      displayName: string;
      avatars: unknown;
      reason: string;
      identifiers: Array<{
        identifierType: string;
        identifierValue: string;
        connectorType: string | null;
      }>;
    }>
  > {
    const selfId = await this.resolveSelfContactId(userId);
    if (!selfId) return [];

    const db = this.dbService.db;

    // Load self contact
    const selfRows = await db.select().from(people).where(eq(people.id, selfId));
    if (!selfRows.length) return [];
    const self = selfRows[0];
    const selfDisplayName = this.crypto.decrypt(self.displayName) ?? self.displayName;
    const selfName = selfDisplayName.toLowerCase().trim();
    if (selfName.length < 2) return [];

    // Load self identifiers (email, phone, etc.)
    const selfIdents = await db
      .select()
      .from(personIdentifiers)
      .where(eq(personIdentifiers.personId, selfId));
    const selfIdentValues = new Set(
      selfIdents.map(
        (i) => `${i.identifierType}:${this.crypto.decrypt(i.identifierValue) ?? i.identifierValue}`,
      ),
    );

    // Load dismissed pairs involving self
    const dismissedRows = await db
      .select()
      .from(mergeDismissals)
      .where(
        sql`${mergeDismissals.personId1} = ${selfId} OR ${mergeDismissals.personId2} = ${selfId}`,
      );
    const dismissedIds = new Set(
      dismissedRows.map((d) => (d.personId1 === selfId ? d.personId2 : d.personId1)),
    );

    // Find candidates: persons with matching name or shared identifiers (user-scoped)
    const personConditions: SQLWrapper[] = [
      sql`${people.id} != ${selfId}`,
      sql`COALESCE(${people.entityType}, 'person') = 'person'`,
    ];
    if (userId) personConditions.push(eq(people.userId, userId));
    const allPersons = await db
      .select()
      .from(people)
      .where(and(...personConditions));

    const candidates: Array<{
      id: string;
      displayName: string;
      avatars: unknown;
      reason: string;
      identifiers: Array<{
        identifierType: string;
        identifierValue: string;
        connectorType: string | null;
      }>;
    }> = [];

    for (const c of allPersons) {
      if (dismissedIds.has(c.id)) continue;

      const cDisplayName = this.crypto.decrypt(c.displayName) ?? c.displayName;
      const cName = cDisplayName.toLowerCase().trim();
      if (cName.length < 2) continue;

      let reason = '';

      // Check shared identifiers (email/phone) — highest confidence, check first
      const cIdents = await db
        .select()
        .from(personIdentifiers)
        .where(eq(personIdentifiers.personId, c.id));
      for (const ci of cIdents) {
        if (ci.identifierType === 'name') continue;
        const ciValue = this.crypto.decrypt(ci.identifierValue) ?? ci.identifierValue;
        if (selfIdentValues.has(`${ci.identifierType}:${ciValue}`)) {
          reason = `Shares ${ci.identifierType}: ${ciValue}`;
          break;
        }
      }

      // Check exact name match
      if (!reason && selfName === cName) {
        reason = `Exact name match: "${cDisplayName}"`;
      }

      // Check name substring match — require shared non-name identifier too
      if (!reason) {
        const shorter = Math.min(selfName.length, cName.length);
        const longer = Math.max(selfName.length, cName.length);
        if (
          shorter >= 4 &&
          shorter / longer >= 0.4 &&
          (selfName.includes(cName) || cName.includes(selfName))
        ) {
          // Only suggest if they also share a non-name identifier
          const hasSharedIdent = cIdents.some(
            (ci) =>
              ci.identifierType !== 'name' &&
              selfIdentValues.has(
                `${ci.identifierType}:${this.crypto.decrypt(ci.identifierValue) ?? ci.identifierValue}`,
              ),
          );
          if (hasSharedIdent) {
            reason = `Name matches: "${selfDisplayName}" and "${cDisplayName}"`;
          }
        }
      }

      if (!reason) continue;

      // Load identifiers for display
      const idents = await db
        .select()
        .from(personIdentifiers)
        .where(eq(personIdentifiers.personId, c.id));
      candidates.push({
        id: c.id,
        displayName: cDisplayName,
        avatars: c.avatars || [],
        reason,
        identifiers: idents.map((i) => ({
          identifierType: i.identifierType,
          identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
          connectorType: i.connectorType,
        })),
      });
    }

    return candidates;
  }

  /**
   * Build the full /api/me response.
   */
  async getMe(userId?: string) {
    const db = this.dbService.db;

    // Resolve self contact
    let selfContactId = await this.resolveSelfContactId(userId);

    // Auto-create self contact from user's account data if not yet resolved
    if (!selfContactId && userId) {
      const userRows = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId));
      if (userRows.length && userRows[0].email) {
        const { email, name } = userRows[0];
        const identifiers: Array<{ type: string; value: string }> = [
          { type: 'email', value: email },
        ];
        if (name) identifiers.push({ type: 'name', value: name });
        const contact = await this.contactsService.resolvePerson(identifiers, 'person', userId);
        await this.setSelfContact(contact.id, userId);
        selfContactId = contact.id;
      }
    }

    // Build identity from self contact
    const identity: {
      name: string | null;
      email: string | null;
      phone: string | null;
      avatars: Array<{ url: string; source: string }>;
      preferredAvatarIndex: number;
      contactId: string | null;
    } = {
      name: null,
      email: null,
      phone: null,
      avatars: [],
      preferredAvatarIndex: 0,
      contactId: selfContactId,
    };

    if (selfContactId) {
      const contactRows = await db.select().from(people).where(eq(people.id, selfContactId));

      if (contactRows.length) {
        const contact = contactRows[0];
        identity.name = this.crypto.decrypt(contact.displayName) ?? contact.displayName;
        identity.preferredAvatarIndex = contact.preferredAvatarIndex ?? 0;
        try {
          identity.avatars = (contact.avatars as Array<{ url: string; source: string }>) || [];
        } catch {
          identity.avatars = [];
        }

        // Get identifiers for email/phone
        const idents = await db
          .select()
          .from(personIdentifiers)
          .where(eq(personIdentifiers.personId, selfContactId));

        for (const ident of idents) {
          const decryptedValue =
            this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;
          if (ident.identifierType === 'email' && !identity.email) {
            identity.email = decryptedValue;
          }
          if (ident.identifierType === 'phone' && !identity.phone) {
            identity.phone = decryptedValue;
          }
        }
      }
    }

    // Build accounts list with stats — user-scoped
    const accountFilter = userId ? eq(accounts.userId, userId) : undefined;
    const userAccounts = await db.select().from(accounts).where(accountFilter);
    // Count actual memories per account from DB (not raw events)
    const memCountRows = await db
      .select({ accountId: memories.accountId, count: sql<number>`count(*)::int` })
      .from(memories)
      .groupBy(memories.accountId);
    const memCountMap = new Map(memCountRows.map((r) => [r.accountId, r.count]));
    const accountsList = userAccounts.map((acct) => ({
      id: acct.id,
      connectorType: acct.connectorType,
      identifier: this.crypto.decrypt(acct.identifier) ?? acct.identifier,
      status: acct.status,
      lastSyncAt: acct.lastSyncAt,
      memoriesCount: memCountMap.get(acct.id) ?? 0,
    }));

    const userAccountIds = userAccounts.map((a) => a.id);

    // Stats — only count fully-processed memories for this user
    const doneConditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds.length > 0) {
      doneConditions.push(inArray(memories.accountId, userAccountIds));
    }
    const doneFilter =
      userAccountIds.length === 0 && userId
        ? sql`1=0` // User has no accounts — zero results
        : and(...doneConditions);

    const totalMemoriesResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(doneFilter);
    const totalMemories = totalMemoriesResult[0].count;

    const contactFilter = userId ? eq(people.userId, userId) : undefined;
    const totalContactsResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(people)
      .where(contactFilter);
    const totalContacts = totalContactsResult[0].count;

    const memoriesByConnectorRows = await db
      .select({
        connectorType: memories.connectorType,
        count: sql<number>`count(*)`,
      })
      .from(memories)
      .where(doneFilter)
      .groupBy(memories.connectorType);
    const memoriesByConnector: Record<string, number> = {};
    for (const row of memoriesByConnectorRows) {
      memoriesByConnector[row.connectorType] = row.count;
    }

    const memoriesByTypeRows = await db
      .select({
        sourceType: memories.sourceType,
        count: sql<number>`count(*)`,
      })
      .from(memories)
      .where(doneFilter)
      .groupBy(memories.sourceType);
    const memoriesByType: Record<string, number> = {};
    for (const row of memoriesByTypeRows) {
      memoriesByType[row.sourceType] = row.count;
    }

    const oldestMemoryRow = await db
      .select({ eventTime: memories.eventTime })
      .from(memories)
      .where(doneFilter)
      .orderBy(sql`${memories.eventTime} ASC`)
      .limit(1);
    const oldestMemory = oldestMemoryRow[0]?.eventTime || null;

    const newestMemoryRow = await db
      .select({ eventTime: memories.eventTime })
      .from(memories)
      .where(doneFilter)
      .orderBy(sql`${memories.eventTime} DESC`)
      .limit(1);
    const newestMemory = newestMemoryRow[0]?.eventTime || null;

    // Top entities — parse JSON entities from user's memories
    const entityConditions: SQLWrapper[] = [sql`${memories.entities} != '[]'`];
    if (userAccountIds.length > 0) {
      entityConditions.push(inArray(memories.accountId, userAccountIds));
    } else if (userId) {
      entityConditions.push(sql`1=0`);
    }
    const allEntitiesRows = await db
      .select({ entities: memories.entities })
      .from(memories)
      .where(and(...entityConditions));

    // entityCounts keyed by lowercase for dedup; entityDisplayNames tracks original casing (first seen)
    const entityCounts = new Map<string, number>();
    const entityDisplayNames = new Map<string, string>();
    for (const row of allEntitiesRows) {
      try {
        const decryptedEntities = this.crypto.decrypt(row.entities) ?? row.entities;
        const entities: Array<{ name?: string; type?: string; value?: string }> =
          JSON.parse(decryptedEntities);
        for (const entity of entities) {
          const raw = entity.name || entity.value || '';
          if (!raw) continue;
          const key = raw.toLowerCase().trim();
          if (!entityDisplayNames.has(key)) entityDisplayNames.set(key, raw);
          entityCounts.set(key, (entityCounts.get(key) || 0) + 1);
        }
      } catch {
        // Skip unparseable
      }
    }

    const topEntities = Array.from(entityCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([key, count]) => ({ name: entityDisplayNames.get(key) ?? key, count }));

    // Recent memories involving the user
    let recentMemories: Array<{
      id: string;
      connectorType: string;
      sourceType: string;
      text: string;
      eventTime: Date;
    }> = [];

    if (selfContactId) {
      const recentRows = await db
        .select({
          id: memories.id,
          connectorType: memories.connectorType,
          sourceType: memories.sourceType,
          text: memories.text,
          eventTime: memories.eventTime,
          keyVersion: memories.keyVersion,
        })
        .from(memoryPeople)
        .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
        .where(eq(memoryPeople.personId, selfContactId))
        .orderBy(desc(memories.eventTime))
        .limit(20);

      recentMemories = recentRows.map((row) => {
        const kv = (row.keyVersion ?? 0) as number;
        let text = row.text;
        if (kv >= 1 && userId) {
          const userKey = this.userKeyService.getKey(userId);
          if (userKey) {
            text = this.crypto.decryptWithKey(row.text, userKey) ?? text;
          } else {
            text = '[Encrypted — enter your recovery key to view]';
          }
        } else {
          text = this.crypto.decrypt(row.text) ?? text;
        }
        return {
          id: row.id,
          connectorType: row.connectorType,
          sourceType: row.sourceType,
          text,
          eventTime: row.eventTime,
        };
      });
    }

    return {
      identity,
      accounts: accountsList,
      stats: {
        totalMemories,
        totalContacts,
        memoriesByConnector,
        memoriesByType,
        oldestMemory,
        newestMemory,
      },
      topEntities,
      recentMemories,
    };
  }
}
