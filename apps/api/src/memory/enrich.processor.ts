import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { SettingsService } from '../settings/settings.service';
import { memories, memoryLinks } from '../db/schema';
import { entityExtractionPrompt, factualityPrompt } from './prompts';
import { TRUST_SCORES } from './memory.service';

const SIMILARITY_THRESHOLD = 0.8;
const SIMILAR_MEMORY_LIMIT = 5;

@Processor('enrich')
export class EnrichProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private logsService: LogsService,
    private events: EventsService,
    private settingsService: SettingsService,
  ) {
    super();
  }

  onModuleInit() {
    const concurrency = parseInt(this.settingsService.get('enrich_concurrency'), 10) || 2;
    this.worker.concurrency = concurrency;
    this.settingsService.onChange((key, value) => {
      if (key === 'enrich_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 2;
      }
    });
  }

  async process(job: Job<{ memoryId: string }>) {
    const { memoryId } = job.data;

    const rows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));

    if (!rows.length) return;
    let memory = rows[0];
    const mid = memoryId.slice(0, 8);
    const pipelineStart = Date.now();

    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[enrich:start] ${memory.sourceType} ${mid} (${memory.text.length} chars)`);

    // Entity extraction
    let t0 = Date.now();
    let entities = await this.extractEntities(memory.text);
    const entityMs = Date.now() - t0;
    if (entities.length) {
      await this.dbService.db
        .update(memories)
        .set({ entities: JSON.stringify(entities) })
        .where(eq(memories.id, memoryId));
    }
    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[enrich:entities] ${mid} → ${entities.length} entities in ${entityMs}ms`);

    // Factuality labeling
    t0 = Date.now();
    const factuality = await this.classifyFactuality(
      memory.text,
      memory.sourceType,
      memory.connectorType,
    );
    const factMs = Date.now() - t0;
    if (factuality) {
      await this.dbService.db
        .update(memories)
        .set({ factuality: JSON.stringify(factuality) })
        .where(eq(memories.id, memoryId));
    }
    const factLabel = factuality?.label || 'unclassified';
    const factConf = factuality?.confidence?.toFixed(2) || '?';
    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[enrich:factuality] ${mid} → ${factLabel} (${factConf}) in ${factMs}ms`);

    // Graph link creation — find similar memories via Qdrant
    t0 = Date.now();
    await this.createLinks(memoryId);
    const linkMs = Date.now() - t0;

    // Compute and store base weights
    const ageDays = (Date.now() - new Date(memory.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-0.015 * ageDays);
    const importance = 0.5 + Math.min(entities.length * 0.1, 0.4);
    const trust = TRUST_SCORES[memory.connectorType] || 0.7;
    const weights = { semantic: 0, rerank: 0, recency, importance, trust, final: 0 };

    await this.dbService.db
      .update(memories)
      .set({ weights: JSON.stringify(weights) })
      .where(eq(memories.id, memoryId));

    const totalMs = Date.now() - pipelineStart;
    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[enrich:done] ${mid} in ${totalMs}ms — entities=${entityMs}ms(${entities.length}) factuality=${factMs}ms(${factLabel}) links=${linkMs}ms`);
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'enrich';
    this.logsService.add({ connectorType, accountId: accountId ?? undefined, stage, level, message });
    this.events.emitToChannel('logs', 'log', { connectorType, accountId, stage, level, message, timestamp: new Date().toISOString() });
  }

  private async extractEntities(text: string): Promise<Array<{ type: string; value: string; confidence: number }>> {
    try {
      const response = await this.ollama.generate(entityExtractionPrompt(text));
      return this.parseJsonArray(response);
    } catch {
      return [];
    }
  }

  private async classifyFactuality(
    text: string,
    sourceType: string,
    connectorType: string,
  ): Promise<{ label: string; confidence: number; rationale: string } | null> {
    try {
      const response = await this.ollama.generate(
        factualityPrompt(text, sourceType, connectorType),
      );
      const parsed = this.parseJsonObject(response);
      if (parsed && parsed.label && typeof parsed.confidence === 'number') {
        return parsed as { label: string; confidence: number; rationale: string };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async createLinks(memoryId: string): Promise<void> {
    try {
      const results = await this.qdrant.recommend(memoryId, SIMILAR_MEMORY_LIMIT);

      for (const result of results) {
        if (result.score >= SIMILARITY_THRESHOLD && result.id !== memoryId) {
          await this.dbService.db.insert(memoryLinks).values({
            id: randomUUID(),
            srcMemoryId: memoryId,
            dstMemoryId: result.id,
            linkType: 'related',
            strength: result.score,
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Link creation is best-effort
    }
  }

  private parseJsonArray(text: string): any[] {
    try {
      // Try to extract JSON from the response
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  private parseJsonObject(text: string): Record<string, unknown> | null {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
