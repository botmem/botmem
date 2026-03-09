import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq, and, inArray, lt } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { memories, memoryBanks } from '../db/schema';

interface ReencryptJobData {
  userId: string;
  oldKey: string; // base64
  newKey: string; // base64
  newKeyVersion: number;
}

@Processor('reencrypt')
export class ReencryptProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ReencryptProcessor.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.concurrency = 1;
    this.worker.on('error', (err) => this.logger.warn(`[reencrypt worker] ${err.message}`));
  }

  async process(job: Job<ReencryptJobData>) {
    const { userId, oldKey, newKey, newKeyVersion } = job.data;
    const oldKeyBuffer = Buffer.from(oldKey, 'base64');
    const newKeyBuffer = Buffer.from(newKey, 'base64');
    const db = this.dbService.db;
    const BATCH_SIZE = 100;

    // Get user's memory bank IDs
    const banks = await db
      .select({ id: memoryBanks.id })
      .from(memoryBanks)
      .where(eq(memoryBanks.userId, userId));
    const bankIds = banks.map((b) => b.id);

    if (!bankIds.length) {
      this.logger.log(`[reencrypt] No memory banks for user ${userId}, nothing to re-encrypt`);
      return;
    }

    // Count total
    const countRows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(inArray(memories.memoryBankId, bankIds), lt(memories.keyVersion, newKeyVersion)));
    const total = countRows.length;

    if (total === 0) {
      this.logger.log(`[reencrypt] No memories need re-encryption for user ${userId}`);
      return;
    }

    let processed = 0;

    while (true) {
      const batch = await db
        .select()
        .from(memories)
        .where(and(inArray(memories.memoryBankId, bankIds), lt(memories.keyVersion, newKeyVersion)))
        .limit(BATCH_SIZE);

      if (!batch.length) break;

      for (const mem of batch) {
        try {
          let decryptedText: string | null;
          let decryptedEntities: string | null;
          let decryptedClaims: string | null;
          let decryptedMetadata: string | null;

          if (mem.keyVersion === 0) {
            // Legacy APP_SECRET encrypted — or plaintext if encryption failed originally
            decryptedText = this.crypto.isEncrypted(mem.text)
              ? this.crypto.decrypt(mem.text)
              : mem.text;
            decryptedEntities = this.crypto.isEncrypted(mem.entities)
              ? this.crypto.decrypt(mem.entities)
              : mem.entities;
            decryptedClaims = this.crypto.isEncrypted(mem.claims)
              ? this.crypto.decrypt(mem.claims)
              : mem.claims;
            decryptedMetadata = this.crypto.isEncrypted(mem.metadata)
              ? this.crypto.decrypt(mem.metadata)
              : mem.metadata;
          } else {
            // Encrypted with old user key
            decryptedText = this.crypto.decryptWithKey(mem.text, oldKeyBuffer);
            decryptedEntities = this.crypto.decryptWithKey(mem.entities, oldKeyBuffer);
            decryptedClaims = this.crypto.decryptWithKey(mem.claims, oldKeyBuffer);
            decryptedMetadata = this.crypto.decryptWithKey(mem.metadata, oldKeyBuffer);
          }

          // Re-encrypt with new key
          const encText = this.crypto.encryptWithKey(decryptedText, newKeyBuffer);
          const encEntities = this.crypto.encryptWithKey(decryptedEntities, newKeyBuffer);
          const encClaims = this.crypto.encryptWithKey(decryptedClaims, newKeyBuffer);
          const encMetadata = this.crypto.encryptWithKey(decryptedMetadata, newKeyBuffer);

          await db
            .update(memories)
            .set({
              text: encText ?? mem.text,
              entities: encEntities ?? mem.entities,
              claims: encClaims ?? mem.claims,
              metadata: encMetadata ?? mem.metadata,
              keyVersion: newKeyVersion,
            })
            .where(eq(memories.id, mem.id));

          processed++;
        } catch (err: any) {
          this.logger.warn(`[reencrypt] Failed to re-encrypt memory ${mem.id}: ${err.message}`);
          // Mark as processed to avoid infinite loop on persistently failing rows
          processed++;
          // Update keyVersion anyway to avoid re-processing
          await db
            .update(memories)
            .set({ keyVersion: newKeyVersion })
            .where(eq(memories.id, mem.id));
        }
      }

      await job.updateProgress({ processed, total });
    }

    this.logger.log(
      `[reencrypt] Re-encryption complete for user ${userId}: ${processed} memories processed`,
    );
  }
}
