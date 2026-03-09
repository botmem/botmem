import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { memories } from '../db/schema';

const BATCH_SIZE = 500;

@Processor('maintenance')
export class DecayProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DecayProcessor.name);
  constructor(
    private dbService: DbService,
    private connectors: ConnectorsService,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[maintenance worker] ${err.message}`));
  }

  async process(job: Job) {
    const db = this.dbService.db;
    let offset = 0;
    let updated = 0;
    let batches = 0;

    while (true) {
      const rows = await db
        .select()
        .from(memories)
        .where(eq(memories.embeddingStatus, 'done'))
        .limit(BATCH_SIZE)
        .offset(offset);

      if (rows.length === 0) break;
      batches++;

      for (const mem of rows) {
        const isPinned = !!mem.pinned;
        const recallCount = mem.recallCount || 0;

        const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
        const recency = isPinned ? 1.0 : Math.exp(-0.015 * ageDays);

        let entityCount = 0;
        try {
          entityCount = JSON.parse(mem.entities).length;
        } catch {
          /* empty */
        }
        const baseImportance = 0.5 + Math.min(entityCount * 0.1, 0.4);
        const importance = baseImportance + Math.min(recallCount * 0.02, 0.2);
        const trust = this.getTrustScore(mem.connectorType);

        // Preserve existing semantic/rerank scores
        const parsedWeights = (mem.weights as any) || {};
        const semantic = parsedWeights.semantic ?? 0;
        const rerank = parsedWeights.rerank ?? 0;

        let final =
          rerank > 0
            ? 0.4 * semantic + 0.3 * rerank + 0.15 * recency + 0.1 * importance + 0.05 * trust
            : 0.7 * semantic + 0.15 * recency + 0.1 * importance + 0.05 * trust;

        if (isPinned) final = Math.max(final, 0.75);

        const newWeights = JSON.stringify({ semantic, rerank, recency, importance, trust, final });

        await db.update(memories).set({ weights: newWeights }).where(eq(memories.id, mem.id));

        updated++;
      }

      offset += rows.length;
      await job.updateProgress(offset);
    }

    return { updated, batches };
  }

  private getTrustScore(connectorType: string): number {
    try {
      return this.connectors.get(connectorType).manifest.trustScore;
    } catch {
      return 0.7;
    }
  }
}
