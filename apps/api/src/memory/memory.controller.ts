import { Controller, Get, Post, Delete, Param, Query, Body, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MemoryService, SearchResult } from './memory.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { memories, memoryContacts, rawEvents } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

@Controller('memories')
export class MemoryController {
  constructor(
    private memoryService: MemoryService,
    private dbService: DbService,
    private accountsService: AccountsService,
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

      // Re-enqueue through pipeline with generous retries
      await this.cleanQueue.add(
        'clean',
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

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
