import { Injectable, ConflictException, BadRequestException } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import * as schema from '../db/schema';

const KEY_PREFIX = 'bm_sk_';
const MAX_KEYS_PER_USER = 10;

@Injectable()
export class ApiKeysService {
  constructor(private dbService: DbService) {}

  generateKey(): { raw: string; hash: string; lastFour: string } {
    const hex = randomBytes(16).toString('hex'); // 32 hex chars
    const raw = `${KEY_PREFIX}${hex}`; // 41 chars total
    const hash = createHash('sha256').update(raw).digest('hex');
    const lastFour = hex.slice(-4);
    return { raw, hash, lastFour };
  }

  async create(userId: string, name: string, expiresAt?: string) {
    const db = this.dbService.db;

    // Check key count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.userId, userId), isNull(schema.apiKeys.revokedAt)));
    const count = countResult[0]?.count ?? 0;
    if (count >= MAX_KEYS_PER_USER) {
      throw new BadRequestException(`Maximum ${MAX_KEYS_PER_USER} API keys per user`);
    }

    // Check name uniqueness
    const existing = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.userId, userId), eq(schema.apiKeys.name, name), isNull(schema.apiKeys.revokedAt)))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException(`API key with name "${name}" already exists`);
    }

    const { raw, hash, lastFour } = this.generateKey();
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();

    await db.insert(schema.apiKeys).values({
      id,
      userId,
      name,
      keyHash: hash,
      lastFour,
      memoryBankIds: null,
      expiresAt: expiresAt || null,
      revokedAt: null,
      createdAt: now,
    });

    return { key: raw, id, name, lastFour };
  }

  async listByUser(userId: string) {
    const db = this.dbService.db;
    const rows = await db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        lastFour: schema.apiKeys.lastFour,
        createdAt: schema.apiKeys.createdAt,
        expiresAt: schema.apiKeys.expiresAt,
        revokedAt: schema.apiKeys.revokedAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.userId, userId));
    return rows;
  }

  async revoke(userId: string, keyId: string) {
    const db = this.dbService.db;
    const now = new Date().toISOString();
    const result = await db
      .update(schema.apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.userId, userId)));
    return result;
  }

  async validateKey(rawKey: string) {
    const hash = createHash('sha256').update(rawKey).digest('hex');
    const db = this.dbService.db;
    const rows = await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, hash), isNull(schema.apiKeys.revokedAt)))
      .limit(1);

    if (rows.length === 0) return null;

    const key = rows[0];

    // Check expiration
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return null;
    }

    return key;
  }
}
