import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  HttpStatus,
  Logger,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { MemoryService } from './memory.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { AiService } from './ai.service';
import { QdrantService } from './qdrant.service';
import { EventsService } from '../events/events.service';
import { accounts, memories, memoryContacts, rawEvents, jobs } from '../db/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { SearchMemoriesDto } from './dto/search-memories.dto';
import { BackfillEnrichDto } from './dto/backfill-enrich.dto';

@Controller('memories')
export class MemoryController {
  private readonly logger = new Logger(MemoryController.name);
  constructor(
    private memoryService: MemoryService,
    private dbService: DbService,
    private accountsService: AccountsService,
    private ai: AiService,
    private qdrant: QdrantService,
    private events: EventsService,
    @InjectQueue('backfill') private backfillQueue: Queue,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
  ) {}

  @Get('stats')
  async getStats(@CurrentUser() user: { id: string; memoryBankIds?: string[] }) {
    const stats = await this.memoryService.getStats(user.id, user.memoryBankIds);
    return { ...stats, needsRecoveryKey: await this.memoryService.needsRecoveryKey(user.id) };
  }

  @RequiresJwt()
  @Get('queue-status')
  async getQueueStatus() {
    const queues = {
      clean: this.cleanQueue,
      embed: this.embedQueue,
      enrich: this.enrichQueue,
      backfill: this.backfillQueue,
    };
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
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Query('memoryLimit', new DefaultValuePipe(5000), ParseIntPipe) memoryLimit: number,
    @Query('linkLimit', new DefaultValuePipe(50000), ParseIntPipe) linkLimit: number,
    @Query('memoryBankId') memoryBankId?: string,
    @Query('memoryIds') memoryIdsParam?: string,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { nodes: [], edges: [], needsRecoveryKey: true };
    const ml = Math.min(memoryLimit, 10000);
    const ll = Math.min(linkLimit, 100000);
    const memoryIds = memoryIdsParam ? memoryIdsParam.split(',').filter(Boolean) : undefined;
    return this.memoryService.getGraphData(ml, ll, user.id, memoryBankId, user.memoryBankIds, memoryIds);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get()
  async list(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('memoryBankId') memoryBankId?: string,
  ) {
    const needsRecoveryKey = await this.memoryService.needsRecoveryKey(user.id);
    if (needsRecoveryKey) return { items: [], total: 0, needsRecoveryKey: true };
    return this.memoryService.list({
      limit,
      offset,
      connectorType,
      sourceType,
      userId: user.id,
      memoryBankId,
      memoryBankIds: user.memoryBankIds,
    });
  }

  @RequiresJwt()
  @Post('retry-failed')
  async retryFailed(@Query('limit') limitParam?: string) {
    const db = this.dbService.db;
    const batchLimit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 2000) : 200;

    // Find failed and stuck pending memories
    const failed = await db
      .select({
        id: memories.id,
        sourceId: memories.sourceId,
        connectorType: memories.connectorType,
      })
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

        // Delete the failed memory (and its contact links) atomically
        await this.dbService.db.transaction(async (tx) => {
          await tx.delete(memoryContacts).where(eq(memoryContacts.memoryId, mem.id));
          await tx.delete(memories).where(eq(memories.id, mem.id));
        });

        // Re-enqueue through pipeline with generous retries
        await this.cleanQueue.add(
          'clean',
          { rawEventId: rawRows[0].id },
          { attempts: 5, backoff: { type: 'exponential', delay: 10000 } },
        );
        enqueued++;
      } catch (err: any) {
        errors++;
        this.logger.error(`[retry-failed] ${mem.id}: ${err?.message}`);
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
  @Post('backfill-enrich')
  async backfillEnrich(@CurrentUser() user: { id: string }, @Body() dto: BackfillEnrichDto) {
    const db = this.dbService.db;

    // Build WHERE conditions: embeddingStatus=done AND enrichedAt IS NULL
    const conditions = [eq(memories.embeddingStatus, 'done'), isNull(memories.enrichedAt)];
    if (dto.connectorType) {
      conditions.push(eq(memories.connectorType, dto.connectorType));
    }

    const targets = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(...conditions));

    if (targets.length === 0) {
      return { jobId: null, enqueued: 0, total: 0, message: 'No memories need re-enrichment' };
    }

    // Get user's first account for jobs FK
    const userAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id))
      .limit(1);

    if (!userAccounts.length) {
      return { error: 'No account found -- sync a connector first' };
    }

    const now = new Date();
    const jobId = randomUUID();

    // Create tracked job row
    await db.insert(jobs).values({
      id: jobId,
      accountId: userAccounts[0].id,
      connectorType: dto.connectorType || 'backfill',
      status: 'running',
      progress: 0,
      total: targets.length,
      startedAt: now,
      createdAt: now,
    });

    // Enqueue individual BullMQ jobs
    for (const t of targets) {
      await this.backfillQueue.add(
        'backfill-enrich',
        { memoryId: t.id, jobId },
        {
          jobId: t.id,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
    }

    // Emit initial progress
    this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
      jobId,
      processed: 0,
      total: targets.length,
    });

    return { jobId, enqueued: targets.length, total: targets.length };
  }

  @RequiresJwt()
  @Post('backfill-thumbnails')
  async backfillThumbnails(@CurrentUser() user: { id: string }) {
    const db = this.dbService.db;

    // Find photo memories without thumbnailBase64 in metadata
    const photoMemories = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.sourceType, 'photo'),
          eq(memories.pipelineComplete, true),
          sql`metadata IS NOT NULL AND metadata <> '' AND left(metadata, 1) = '{' AND (metadata::jsonb->>'thumbnailBase64') IS NULL AND (metadata::jsonb->>'fileUrl') IS NOT NULL`,
        ),
      );

    if (!photoMemories.length) {
      return { jobId: null, enqueued: 0, message: 'All photos already have thumbnails' };
    }

    const userAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id))
      .limit(1);

    if (!userAccounts.length) {
      return { error: 'No account found -- sync a connector first' };
    }

    const now = new Date();
    const jobId = randomUUID();

    await db.insert(jobs).values({
      id: jobId,
      accountId: userAccounts[0].id,
      connectorType: 'backfill',
      status: 'running',
      progress: 0,
      total: photoMemories.length,
      startedAt: now,
      createdAt: now,
    });

    for (const m of photoMemories) {
      await this.backfillQueue.add(
        'backfill-thumbnails',
        { memoryId: m.id, jobId },
        { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
      );
    }

    this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
      jobId,
      processed: 0,
      total: photoMemories.length,
    });

    return { jobId, enqueued: photoMemories.length, total: photoMemories.length };
  }

  @RequiresJwt()
  @Post('backfill-embeddings')
  async backfillEmbeddings(@Query('limit') limitParam?: string) {
    const db = this.dbService.db;
    const batchLimit = limitParam ? Math.min(parseInt(limitParam, 10) || 500, 5000) : 500;

    // Find memories marked done in Postgres that might be missing from Qdrant
    const doneMemories = await db
      .select({
        id: memories.id,
        text: memories.text,
        sourceType: memories.sourceType,
        connectorType: memories.connectorType,
        eventTime: memories.eventTime,
        accountId: memories.accountId,
        memoryBankId: memories.memoryBankId,
      })
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
        if (exists) {
          skipped++;
          continue;
        }

        const maxChars = 6000;
        const text = mem.text.length > maxChars ? mem.text.slice(0, maxChars) : mem.text;
        const vector = await this.ai.embed(text);
        await this.qdrant.upsert(mem.id, vector, {
          source_type: mem.sourceType,
          connector_type: mem.connectorType,
          event_time: mem.eventTime,
          account_id: mem.accountId,
          memory_bank_id: (mem as any).memoryBankId || null,
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

  @RequiresJwt()
  @Get('qdrant-info')
  async getQdrantInfo() {
    return this.qdrant.getCollectionInfo();
  }

  @Get('timeline')
  async timeline(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('memoryBankId') memoryBankId?: string,
  ) {
    return this.memoryService.timeline({
      from,
      to,
      connectorType,
      sourceType,
      query,
      limit: limit ? parseInt(limit, 10) : undefined,
      userId: user.id,
      memoryBankId,
      memoryBankIds: user.memoryBankIds,
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
    const types = type
      ? type
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    return this.memoryService.searchEntities(q, limit ? parseInt(limit, 10) : undefined, types);
  }

  @Get('entities/:value/graph')
  async getEntityGraph(@Param('value') value: string, @Query('limit') limit?: string) {
    return this.memoryService.getEntityGraph(
      decodeURIComponent(value),
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @SkipThrottle()
  @RequiresJwt()
  @Get(':id/thumbnail')
  async getThumbnail(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Res() res: Response,
  ) {
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return res.status(HttpStatus.NOT_FOUND).json({ error: 'not found' });

    let metadata: any = {};
    try {
      metadata =
        typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : memory.metadata || {};
    } catch {
      // metadata may be encrypted ciphertext when user key is not loaded
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: 'encrypted' });
    }

    // Serve from stored thumbnail if available (no upstream fetch needed)
    if (metadata.thumbnailBase64) {
      const buffer = Buffer.from(metadata.thumbnailBase64, 'base64');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(buffer);
    }

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
      } catch (err) {
        this.logger.warn(
          `Auth lookup failed for account ${memory.accountId}`,
          err instanceof Error ? err.message : String(err),
        );
      }
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
  async getRelated(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.memoryService.getRelated(id, limit ? parseInt(limit, 10) : undefined);
  }

  @Get(':id')
  async getById(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.memoryService.getById(id, user.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('search')
  async search(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Body() dto: SearchMemoriesDto,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { results: [], needsRecoveryKey: true };
    return this.memoryService.search(
      dto.query,
      dto.filters,
      dto.limit,
      dto.rerank,
      user.id,
      dto.memoryBankId,
      user.memoryBankIds,
    );
  }

  @RequiresJwt()
  @Post('relabel-unknown')
  async relabelUnknown() {
    const db = this.dbService.db;

    // Replace "Unknown:" with "A member:" and "Unknown sent" with "A member sent" in WhatsApp memories
    const result1 = await db.execute(sql`
      UPDATE ${memories} SET text = REPLACE(text, 'Unknown:', 'A member:')
      WHERE ${memories.connectorType} = 'whatsapp' AND text LIKE '%Unknown:%'
    `);
    const result2 = await db.execute(sql`
      UPDATE ${memories} SET text = REPLACE(text, 'Unknown sent', 'A member sent')
      WHERE ${memories.connectorType} = 'whatsapp' AND text LIKE '%Unknown sent%'
    `);
    const result3 = await db.execute(sql`
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
    await this.dbService.db.update(memories).set({ pinned: true }).where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Delete(':id/pin')
  async unpin(@Param('id') id: string) {
    await this.dbService.db.update(memories).set({ pinned: false }).where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Post(':id/recall')
  async recall(@Param('id') id: string) {
    await this.dbService.db
      .update(memories)
      .set({ recallCount: sql`recall_count + 1` })
      .where(eq(memories.id, id));
    return { ok: true };
  }

  @RequiresJwt()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
