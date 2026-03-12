import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq, like, and, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { QdrantService } from '../memory/qdrant.service';
import { ConfigService } from '../config/config.service';
import * as schema from '../db/schema';
import { generateContacts, generateMemories, randomVector, scanForPII } from './fake-data';

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private db: DbService,
    private crypto: CryptoService,
    private qdrant: QdrantService,
    private config: ConfigService,
  ) {}

  async seed(
    userId: string,
    memoryBankId: string,
  ): Promise<{
    memories: number;
    contacts: number;
    links: number;
    piiScan: { clean: boolean; flagged: string[] };
  }> {
    const now = new Date();

    // 1. Create demo accounts
    const connectorTypes = ['gmail', 'slack', 'whatsapp', 'imessage', 'photos-immich'];
    const accountIds: Record<string, string> = {};

    for (const type of connectorTypes) {
      const id = randomUUID();
      accountIds[type] = id;
      await this.db.withUserId(userId, (db) =>
        db.insert(schema.accounts).values({
          id,
          userId,
          connectorType: type,
          identifier: `demo-${type}`,
          status: 'connected',
          schedule: 'manual',
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 2. Generate contacts
    const fakeContacts = generateContacts(100);
    const contactIdMap: Record<number, string> = {};

    for (let i = 0; i < fakeContacts.length; i++) {
      const fc = fakeContacts[i];
      contactIdMap[i] = fc.id;

      await this.db.withUserId(userId, (db) =>
        db.insert(schema.people).values({
          id: fc.id,
          userId,
          displayName: fc.displayName,
          entityType: fc.entityType,
          avatars: [],
          metadata: {},
          createdAt: now,
          updatedAt: now,
        }),
      );

      for (const ident of fc.identifiers) {
        await this.db.withUserId(userId, (db) =>
          db.insert(schema.personIdentifiers).values({
            id: randomUUID(),
            personId: fc.id,
            identifierType: ident.type,
            identifierValue: ident.value,
            connectorType: ident.connectorType,
            confidence: 1.0,
            createdAt: now,
          }),
        );
      }
    }

    // 3. Generate memories
    const fakeMemories = generateMemories(fakeContacts, {
      gmail: 150,
      slack: 100,
      whatsapp: 100,
      imessage: 80,
      photos: 70,
    });

    // PII scan
    const piiScan = scanForPII(fakeMemories.map((m) => m.text));
    if (!piiScan.clean) {
      this.logger.warn(
        `PII scan flagged ${piiScan.flagged.length} items: ${piiScan.flagged.join(', ')}`,
      );
    }

    const dim = this.config.embedDimension;

    for (const mem of fakeMemories) {
      const accountId = accountIds[mem.connectorType];
      const encrypted = this.crypto.encryptMemoryFields({
        text: mem.text,
        entities: JSON.stringify(mem.entities),
        claims: JSON.stringify(mem.claims),
        metadata: JSON.stringify(mem.metadata),
      });

      await this.db.withUserId(userId, (db) =>
        db
          .insert(schema.memories)
          .values({
            id: mem.id,
            accountId,
            memoryBankId,
            connectorType: mem.connectorType,
            sourceType: mem.sourceType,
            sourceId: mem.sourceId,
            text: encrypted.text,
            eventTime: mem.eventTime,
            ingestTime: now,
            factuality: JSON.stringify(mem.factuality),
            weights: mem.weights,
            entities: encrypted.entities,
            claims: encrypted.claims,
            metadata: encrypted.metadata,
            embeddingStatus: 'done',
            pinned: false,
            recallCount: 0,
            keyVersion: 0,
            pipelineComplete: true,
            enrichedAt: now,
            createdAt: now,
          })
          .onConflictDoNothing(),
      );

      // Qdrant vector
      const vector = randomVector(dim);
      await this.qdrant.upsert(mem.id, vector, {
        source_type: mem.sourceType,
        connector_type: mem.connectorType,
        event_time: mem.eventTime.toISOString(),
        account_id: accountId,
        memory_bank_id: memoryBankId,
      });

      // Memory-contact links
      for (let j = 0; j < mem.contactIndices.length; j++) {
        const contactId = contactIdMap[mem.contactIndices[j]];
        if (contactId) {
          await this.db.withUserId(userId, (db) =>
            db.insert(schema.memoryPeople).values({
              id: randomUUID(),
              memoryId: mem.id,
              personId: contactId,
              role: mem.contactRoles[j] || 'mentioned',
            }),
          );
        }
      }
    }

    // 4. Generate memory links (~200)
    const linkCount = Math.min(200, Math.floor(fakeMemories.length * 0.4));
    let linksCreated = 0;
    const usedPairs = new Set<string>();

    for (let i = 0; i < linkCount; i++) {
      const src = fakeMemories[randInt(0, fakeMemories.length - 1)];
      const dst = fakeMemories[randInt(0, fakeMemories.length - 1)];
      if (src.id === dst.id) continue;
      const pairKey = [src.id, dst.id].sort().join(':');
      if (usedPairs.has(pairKey)) continue;
      usedPairs.add(pairKey);

      const linkType = pick(['related', 'related', 'related', 'supports', 'contradicts']);
      await this.db.withUserId(userId, (db) =>
        db.insert(schema.memoryLinks).values({
          id: randomUUID(),
          srcMemoryId: src.id,
          dstMemoryId: dst.id,
          linkType,
          strength: randFloat(0.3, 0.9),
          createdAt: now,
        }),
      );
      linksCreated++;
    }

    this.logger.log(
      `Demo data seeded for user ${userId}: ${fakeMemories.length} memories, ${fakeContacts.length} contacts, ${linksCreated} links`,
    );

    return {
      memories: fakeMemories.length,
      contacts: fakeContacts.length,
      links: linksCreated,
      piiScan,
    };
  }

  async cleanup(userId: string): Promise<{ deleted: number }> {
    // Find demo accounts
    const demoAccounts = await this.db.db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, userId), like(schema.accounts.identifier, 'demo-%')));

    if (demoAccounts.length === 0) {
      return { deleted: 0 };
    }

    const accountIds = demoAccounts.map((a) => a.id);

    // Find all memory IDs for these accounts
    const demoMemories = await this.db.db
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(inArray(schema.memories.accountId, accountIds));

    const memoryIds = demoMemories.map((m) => m.id);

    if (memoryIds.length > 0) {
      // Delete memory contacts
      await this.db.db
        .delete(schema.memoryPeople)
        .where(inArray(schema.memoryPeople.memoryId, memoryIds));

      // Delete memory links
      await this.db.db
        .delete(schema.memoryLinks)
        .where(inArray(schema.memoryLinks.srcMemoryId, memoryIds));
      await this.db.db
        .delete(schema.memoryLinks)
        .where(inArray(schema.memoryLinks.dstMemoryId, memoryIds));

      // Delete memories
      await this.db.db.delete(schema.memories).where(inArray(schema.memories.id, memoryIds));

      // Remove from Qdrant
      for (const id of memoryIds) {
        await this.qdrant.remove(id);
      }
    }

    // Find contacts created for this user that have no remaining memory links
    const contactsWithLinks = await this.db.db
      .select({ personId: schema.memoryPeople.personId })
      .from(schema.memoryPeople);
    const linkedContactIds = new Set(contactsWithLinks.map((c) => c.personId));

    const userContacts = await this.db.db
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(eq(schema.people.userId, userId));

    const orphanedContactIds = userContacts
      .filter((c) => !linkedContactIds.has(c.id))
      .map((c) => c.id);

    if (orphanedContactIds.length > 0) {
      await this.db.db
        .delete(schema.personIdentifiers)
        .where(inArray(schema.personIdentifiers.personId, orphanedContactIds));
      await this.db.db.delete(schema.people).where(inArray(schema.people.id, orphanedContactIds));
    }

    // Delete demo accounts
    await this.db.db.delete(schema.accounts).where(inArray(schema.accounts.id, accountIds));

    const totalDeleted = memoryIds.length + orphanedContactIds.length + accountIds.length;
    this.logger.log(`Demo data cleaned for user ${userId}: ${totalDeleted} records removed`);

    return { deleted: totalDeleted };
  }

  async hasDemoData(userId: string): Promise<boolean> {
    const result = await this.db.db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, userId), like(schema.accounts.identifier, 'demo-%')))
      .limit(1);
    return result.length > 0;
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
