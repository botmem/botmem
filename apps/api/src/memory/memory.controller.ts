import { Controller, Get, Post, Delete, Param, Query, Body, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MemoryService, SearchResult } from './memory.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { memories, memoryContacts, rawEvents } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';

@Controller('memories')
export class MemoryController {
  constructor(
    private memoryService: MemoryService,
    private dbService: DbService,
    private accountsService: AccountsService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    @InjectQueue('backfill') private backfillQueue: Queue,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
  ) {}

  @Get('stats')
  async getStats() {
    return this.memoryService.getStats();
  }

  @Get('queue-status')
  async getQueueStatus() {
    const queues = { clean: this.cleanQueue, embed: this.embedQueue, enrich: this.enrichQueue, backfill: this.backfillQueue };
    const status: Record<string, unknown> = {};
    for (const [name, queue] of Object.entries(queues)) {
      const [waiting, active, failed, delayed, completed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.getCompletedCount(),
      ]);
      status[name] = { waiting, active, failed, delayed, completed };
    }
    return status;
  }

  @Get('graph')
  async getGraphData(
    @Query('memoryLimit') memoryLimit?: string,
    @Query('linkLimit') linkLimit?: string,
  ) {
    const ml = memoryLimit ? Math.min(parseInt(memoryLimit, 10) || 5000, 10000) : 5000;
    const ll = linkLimit ? Math.min(parseInt(linkLimit, 10) || 50000, 100000) : 50000;
    return this.memoryService.getGraphData(ml, ll);
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

  @RequiresJwt()
  @Post('retry-failed')
  async retryFailed(@Query('limit') limitParam?: string) {
    const db = this.dbService.db;
    const batchLimit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 2000) : 200;

    // Find failed and stuck pending memories
    const failed = await db
      .select({ id: memories.id, sourceId: memories.sourceId, connectorType: memories.connectorType })
      .from(memories)
      .where(sql`${memories.embeddingStatus} IN ('failed', 'pending')`)
      .limit(batchLimit);

    if (!failed.length) return { enqueued: 0, message: 'No failed memories to retry' };

    let enqueued = 0;
    let errors = 0;
    for (const mem of failed) {
      try {
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

        // Re-enqueue through pipeline with generous retries
        await this.cleanQueue.add(
          'clean',
          { rawEventId: rawRows[0].id },
          { attempts: 5, backoff: { type: 'exponential', delay: 10000 } },
        );
        enqueued++;
      } catch (err: any) {
        errors++;
        console.error(`[retry-failed] ${mem.id}: ${err?.message}`);
      }
    }

    return { enqueued, errors, total: failed.length };
  }

  @RequiresJwt()
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

  @RequiresJwt()
  @Post('backfill-embeddings')
  async backfillEmbeddings(@Query('limit') limitParam?: string) {
    const db = this.dbService.db;
    const batchLimit = limitParam ? Math.min(parseInt(limitParam, 10) || 500, 5000) : 500;

    // Find memories marked done in SQLite that might be missing from Qdrant
    const doneMemories = await db
      .select({ id: memories.id, text: memories.text, sourceType: memories.sourceType, connectorType: memories.connectorType, eventTime: memories.eventTime, accountId: memories.accountId })
      .from(memories)
      .where(eq(memories.embeddingStatus, 'done'))
      .limit(batchLimit);

    // Check which are missing from Qdrant by scrolling through points
    const qdrantInfo = await this.qdrant.getCollectionInfo();
    let reembedded = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const mem of doneMemories) {
      try {
        const exists = await this.qdrant.pointExists(mem.id);
        if (exists) { skipped++; continue; }

        const maxChars = 6000;
        const text = mem.text.length > maxChars ? mem.text.slice(0, maxChars) : mem.text;
        const vector = await this.ollama.embed(text);
        await this.qdrant.upsert(mem.id, vector, {
          source_type: mem.sourceType,
          connector_type: mem.connectorType,
          event_time: mem.eventTime,
          account_id: mem.accountId,
        });
        reembedded++;
      } catch (err: any) {
        errors.push(`${mem.id.slice(0, 8)}: ${err?.message}`);
      }
    }

    return {
      checked: doneMemories.length,
      reembedded,
      skipped,
      errors: errors.slice(0, 10),
      qdrant: qdrantInfo,
    };
  }

  @Get('qdrant-info')
  async getQdrantInfo() {
    return this.qdrant.getCollectionInfo();
  }

  @Get('timeline')
  async timeline(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
  ) {
    return this.memoryService.timeline({
      from, to, connectorType, sourceType, query,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('entities/types')
  getEntityTypes() {
    return { types: this.memoryService.getEntityTypes() };
  }

  @Get('entities/search')
  async searchEntities(
    @Query('q') q: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    if (!q) return { entities: [], total: 0 };
    const types = type ? type.split(',').map(t => t.trim()).filter(Boolean) : undefined;
    return this.memoryService.searchEntities(q, limit ? parseInt(limit, 10) : undefined, types);
  }

  @Get('entities/:value/graph')
  async getEntityGraph(
    @Param('value') value: string,
    @Query('limit') limit?: string,
  ) {
    return this.memoryService.getEntityGraph(
      decodeURIComponent(value),
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get(':id/thumbnail')
  async getThumbnail(@Param('id') id: string, @Res() res: Response) {
    const memory = await this.memoryService.getById(id);
    if (!memory) return res.status(HttpStatus.NOT_FOUND).json({ error: 'not found' });

    const metadata = typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : (memory.metadata || {});
    const fileUrl: string | undefined = metadata.fileUrl;
    if (!fileUrl) return res.status(HttpStatus.NOT_FOUND).json({ error: 'no file' });

    // Build auth headers from account
    const headers: Record<string, string> = {};
    if (memory.accountId) {
      try {
        const account = await this.accountsService.getById(memory.accountId);
        const authContext = account.authContext ? JSON.parse(account.authContext) : null;
        if (authContext?.accessToken) {
          if (memory.connectorType === 'photos') {
            headers['x-api-key'] = authContext.accessToken;
          } else {
            headers['Authorization'] = `Bearer ${authContext.accessToken}`;
          }
        }
      } catch {}
    }

    // Use thumbnail size instead of preview for faster loading
    const thumbUrl = fileUrl.replace('size=preview', 'size=thumbnail');

    try {
      const upstream = await fetch(thumbUrl, { headers, signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok) return res.status(upstream.status).end();

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');

      const buffer = Buffer.from(await upstream.arrayBuffer());
      return res.send(buffer);
    } catch {
      return res.status(HttpStatus.BAD_GATEWAY).json({ error: 'upstream failed' });
    }
  }

  @Get(':id/related')
  async getRelated(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.memoryService.getRelated(id, limit ? parseInt(limit, 10) : undefined);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.memoryService.getById(id);
  }

  @Post('search')
  async search(
    @Body() body: { query: string; filters?: Record<string, string>; limit?: number; rerank?: boolean },
  ) {
    return this.memoryService.search(body.query, body.filters, body.limit, body.rerank);
  }

  @RequiresJwt()
  @Post('relabel-unknown')
  async relabelUnknown() {
    const db = this.dbService.db;

    // Replace "Unknown:" with "A member:" and "Unknown sent" with "A member sent" in WhatsApp memories
    const result1 = db.run(sql`
      UPDATE ${memories} SET text = REPLACE(text, 'Unknown:', 'A member:')
      WHERE ${memories.connectorType} = 'whatsapp' AND text LIKE '%Unknown:%'
    `);
    const result2 = db.run(sql`
      UPDATE ${memories} SET text = REPLACE(text, 'Unknown sent', 'A member sent')
      WHERE ${memories.connectorType} = 'whatsapp' AND text LIKE '%Unknown sent%'
    `);
    const result3 = db.run(sql`
      UPDATE ${memories} SET text = REPLACE(text, 'Unknown shared', 'A member shared')
      WHERE ${memories.connectorType} = 'whatsapp' AND text LIKE '%Unknown shared%'
    `);

    return {
      updated: (result1 as any).changes + (result2 as any).changes + (result3 as any).changes,
      message: 'Replaced "Unknown" sender labels with "A member" in WhatsApp memories',
    };
  }

  @RequiresJwt()
  @Post(':id/pin')
  async pin(@Param('id') id: string) {
    await this.dbService.db.update(memories).set({ pinned: 1 }).where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Delete(':id/pin')
  async unpin(@Param('id') id: string) {
    await this.dbService.db.update(memories).set({ pinned: 0 }).where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Post(':id/recall')
  async recall(@Param('id') id: string) {
    await this.dbService.db.update(memories).set({ recallCount: sql`recall_count + 1` }).where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
