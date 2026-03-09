import { Injectable } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { users, refreshTokens, passwordResets } from '../db/schema';

@Injectable()
export class UsersService {
  constructor(private db: DbService) {}

  async createUser(email: string, passwordHash: string, name: string, encryptionSalt?: string) {
    const now = new Date();
    const id = randomUUID();
    await this.db.db.insert(users).values({
      id,
      email: email.toLowerCase().trim(),
      passwordHash,
      name,
      encryptionSalt: encryptionSalt ?? null,
      onboarded: false,
      createdAt: now,
      updatedAt: now,
    });
    return this.findById(id);
  }

  async getEncryptionSalt(userId: string): Promise<string | null> {
    const rows = await this.db.db
      .select({ encryptionSalt: users.encryptionSalt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.encryptionSalt ?? null;
  }

  async updateEncryptionSalt(userId: string, newSalt: string) {
    const now = new Date();
    await this.db.db
      .update(users)
      .set({ encryptionSalt: newSalt, updatedAt: now })
      .where(eq(users.id, userId));
  }

  async incrementKeyVersion(userId: string): Promise<number> {
    const row = await this.findById(userId);
    const newVersion = (row?.keyVersion ?? 0) + 1;
    const now = new Date();
    await this.db.db
      .update(users)
      .set({ keyVersion: newVersion, updatedAt: now })
      .where(eq(users.id, userId));
    return newVersion;
  }

  async getUserKeyVersion(userId: string): Promise<number> {
    const rows = await this.db.db
      .select({ keyVersion: users.keyVersion })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.keyVersion ?? 1;
  }

  async findByEmail(email: string) {
    const rows = await this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string) {
    const rows = await this.db.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByFirebaseUid(firebaseUid: string) {
    const rows = await this.db.db
      .select()
      .from(users)
      .where(eq(users.firebaseUid, firebaseUid))
      .limit(1);
    return rows[0] ?? null;
  }

  async setFirebaseUid(userId: string, firebaseUid: string) {
    const now = new Date();
    await this.db.db.update(users).set({ firebaseUid, updatedAt: now }).where(eq(users.id, userId));
  }

  async saveRefreshToken(
    userId: string,
    tokenHash: string,
    family: string,
    expiresAt: string | Date,
  ) {
    const id = randomUUID();
    const now = new Date();
    const expiresAtDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    await this.db.db.insert(refreshTokens).values({
      id,
      userId,
      tokenHash,
      family,
      expiresAt: expiresAtDate,
      createdAt: now,
    });
    return { id, userId, tokenHash, family, expiresAt, createdAt: now };
  }

  async findRefreshToken(tokenHash: string) {
    const rows = await this.db.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async revokeRefreshToken(id: string) {
    const now = new Date();
    await this.db.db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, id));
  }

  async revokeTokenFamily(family: string) {
    const now = new Date();
    await this.db.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(eq(refreshTokens.family, family));
  }

  async revokeAllUserTokens(userId: string) {
    const now = new Date();
    await this.db.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(eq(refreshTokens.userId, userId));
  }

  async updatePasswordHash(userId: string, newHash: string) {
    const now = new Date();
    await this.db.db
      .update(users)
      .set({ passwordHash: newHash, updatedAt: now })
      .where(eq(users.id, userId));
  }

  async createPasswordReset(userId: string, tokenHash: string, expiresAt: string | Date) {
    const id = randomUUID();
    const now = new Date();
    const expiresAtDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    await this.db.db.insert(passwordResets).values({
      id,
      userId,
      tokenHash,
      expiresAt: expiresAtDate,
      createdAt: now,
    });
    return { id, userId, tokenHash, expiresAt, createdAt: now };
  }

  async invalidateUserResets(userId: string) {
    const now = new Date();
    await this.db.db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  }

  async findPasswordReset(tokenHash: string) {
    const rows = await this.db.db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async setOnboarded(userId: string) {
    const now = new Date();
    await this.db.db
      .update(users)
      .set({ onboarded: true, updatedAt: now })
      .where(eq(users.id, userId));
  }

  async markResetUsed(id: string) {
    const now = new Date();
    await this.db.db.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, id));
  }
}
