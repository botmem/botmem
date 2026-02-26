import { Controller, Get, Post, Delete, Param, Query, Body } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MemoryService, SearchResult } from './memory.service';
import { DbService } from '../db/db.service';
import { memories, memoryContacts, rawEvents } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

@Controller('memories')
export class MemoryController {
  constructor(
    private memoryService: MemoryService,
    private dbService: DbService,
    @InjectQueue('backfill') private backfillQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
  ) {}

  @Get('stats')
  async getStats() {
    return this.memoryService.getStats();
  }

  @Get('graph')
  async getGraphData() {
    return this.memoryService.getGraphData();
  }

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
  ) {
    return this.memoryService.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      connectorType,
      sourceType,
    });
  }

  @Post('retry-failed')
  async retryFailed() {
    const db = this.dbService.db;

    // Find all failed and stuck pending memories
    const failed = await db
      .select({ id: memories.id, sourceId: memories.sourceId, connectorType: memories.connectorType })
      .from(memories)
      .where(sql`${memories.embeddingStatus} IN ('failed', 'pending')`);

    if (!failed.length) return { enqueued: 0, message: 'No failed memories to retry' };

    let enqueued = 0;
    for (const mem of failed) {
      // Find the raw event by source_id
      const rawRows = await db
        .select({ id: rawEvents.id })
        .from(rawEvents)
        .where(eq(rawEvents.sourceId, mem.sourceId))
        .limit(1);

      if (!rawRows.length) continue;

      // Delete the failed memory (and its contact links) so embed processor can recreate
      await db.delete(memoryContacts).where(eq(memoryContacts.memoryId, mem.id));
      await db.delete(memories).where(eq(memories.id, mem.id));

      // Re-enqueue for embedding with generous retries for Ollama availability
      await this.embedQueue.add(
        'embed',
        { rawEventId: rawRows[0].id },
        { attempts: 5, backoff: { type: 'exponential', delay: 10000 } },
      );
      enqueued++;
    }

    return { enqueued, total: failed.length };
  }

  @Post('backfill-contacts')
  async backfillContacts() {
    const db = this.dbService.db;

    // Get memory IDs that don't yet have contact links, in batches
    const unlinked = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        sql`${memories.id} NOT IN (SELECT DISTINCT ${memoryContacts.memoryId} FROM ${memoryContacts})`,
      );

    // Enqueue each as an individual job
    let enqueued = 0;
    for (const { id } of unlinked) {
      await this.backfillQueue.add(
        'backfill-contact',
        { memoryId: id },
        { attempts: 2, backoff: { type: 'exponential', delay: 500 } },
      );
      enqueued++;
    }

    return { enqueued, total: unlinked.length };
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.memoryService.getById(id);
  }

  @Post('search')
  async search(
    @Body() body: { query: string; filters?: Record<string, string>; limit?: number },
  ): Promise<SearchResult[]> {
    return this.memoryService.search(body.query, body.filters, body.limit);
  }

  @Post()
  async insert(@Body() body: { text: string; sourceType?: string; connectorType?: string }) {
    return this.memoryService.insert({
      text: body.text,
      sourceType: body.sourceType || 'manual',
      connectorType: body.connectorType || 'manual',
    });
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
