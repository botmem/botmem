import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { LogsService } from '../logs/logs.service';
import { memories, memoryLinks } from '../db/schema';
import { entityExtractionPrompt, factualityPrompt, photoDescriptionPrompt } from './prompts';

const SIMILARITY_THRESHOLD = 0.8;
const SIMILAR_MEMORY_LIMIT = 5;

@Processor('enrich')
export class EnrichProcessor extends WorkerHost {
  constructor(
    private dbService: DbService,
    private accountsService: AccountsService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private logsService: LogsService,
  ) {
    super();
  }

  async process(job: Job<{ memoryId: string }>) {
    const { memoryId } = job.data;

    const rows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));

    if (!rows.length) return;
    let memory = rows[0];

    await this.logsService.add({
      connectorType: memory.connectorType,
      accountId: memory.accountId ?? undefined,
      level: 'info',
      message: `Enriching ${memory.sourceType} memory ${memoryId.slice(0, 8)}`,
    });

    // Entity extraction
    let entities = await this.extractEntities(memory.text);
    if (entities.length) {
      await this.dbService.db
        .update(memories)
        .set({ entities: JSON.stringify(entities) })
        .where(eq(memories.id, memoryId));
    }

    // Photo-specific: generate visual description via VL model
    if (memory.sourceType === 'photo') {
      try {
        const vlDescription = await this.describePhoto(memory);
        if (vlDescription) {
          const existingMetadata = JSON.parse(memory.metadata);
          const enrichedText = `${memory.text}\nAI Description: ${vlDescription}`;

          await this.dbService.db
            .update(memories)
            .set({
              text: enrichedText,
              metadata: JSON.stringify({ ...existingMetadata, vlDescription }),
            })
            .where(eq(memories.id, memoryId));

          // Re-extract entities from the enriched text
          const enrichedEntities = await this.extractEntities(enrichedText);
          if (enrichedEntities.length > entities.length) {
            entities = enrichedEntities;
            await this.dbService.db
              .update(memories)
              .set({ entities: JSON.stringify(entities) })
              .where(eq(memories.id, memoryId));
          }

          // Refresh memory for subsequent steps
          const updated = await this.dbService.db
            .select()
            .from(memories)
            .where(eq(memories.id, memoryId));
          if (updated.length) memory = updated[0];

          await this.logsService.add({
            connectorType: memory.connectorType,
            accountId: memory.accountId ?? undefined,
            level: 'info',
            message: `VL description generated for photo ${memoryId.slice(0, 8)}`,
          });
        }
      } catch (err: any) {
        await this.logsService.add({
          connectorType: memory.connectorType,
          accountId: memory.accountId ?? undefined,
          level: 'warn',
          message: `Photo VL description failed for ${memoryId.slice(0, 8)}: ${err?.message || err}`,
        });
        // Non-fatal — continue with factuality and linking
      }
    }

    // Factuality labeling
    const factuality = await this.classifyFactuality(
      memory.text,
      memory.sourceType,
      memory.connectorType,
    );
    if (factuality) {
      await this.dbService.db
        .update(memories)
        .set({ factuality: JSON.stringify(factuality) })
        .where(eq(memories.id, memoryId));
    }

    // Graph link creation — find similar memories via Qdrant
    await this.createLinks(memoryId);

    const entityCount = entities.length;
    const factLabel = factuality?.label || 'unclassified';
    await this.logsService.add({
      connectorType: memory.connectorType,
      accountId: memory.accountId ?? undefined,
      level: 'info',
      message: `Enriched memory ${memoryId.slice(0, 8)}: ${entityCount} entities, factuality=${factLabel}`,
    });
  }

  private async describePhoto(memory: any): Promise<string | null> {
    if (!memory.accountId) return null;

    // Look up the Immich server host and API key from the account's auth context
    let account;
    try {
      account = await this.accountsService.getById(memory.accountId);
    } catch {
      return null;
    }

    const authContext = account.authContext ? JSON.parse(account.authContext) : null;
    if (!authContext) return null;

    const host = authContext.raw?.host as string;
    const apiKey = authContext.accessToken as string;
    if (!host || !apiKey) return null;

    // Construct thumbnail URL from the memory's sourceId (Immich asset ID)
    const thumbnailUrl = `${host}/api/assets/${memory.sourceId}/thumbnail?size=preview`;

    const res = await fetch(thumbnailUrl, {
      headers: { 'x-api-key': apiKey },
    });

    if (!res.ok) {
      throw new Error(`Thumbnail fetch failed: ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const description = await this.ollama.generate(
      photoDescriptionPrompt(memory.text),
      [base64],
    );

    return description.trim() || null;
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
