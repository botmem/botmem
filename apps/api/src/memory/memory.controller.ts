import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MemoryService } from './memory.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { AiService } from './ai.service';
import { TypesenseService } from './typesense.service';
import { EventsService } from '../events/events.service';
import { memories, memoryContacts, memoryLinks, rawEvents } from '../db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { ReadOnly } from '../user-auth/decorators/read-only.decorator';
import { SearchMemoriesDto } from './dto/search-memories.dto';
import { AskMemoriesDto } from './dto/ask-memories.dto';
import { AnalyticsService } from '../analytics/analytics.service';

@ApiTags('Memories')
@ApiBearerAuth()
@Controller('memories')
export class MemoryController {
  private readonly logger = new Logger(MemoryController.name);
  constructor(
    private memoryService: MemoryService,
    private dbService: DbService,
    private accountsService: AccountsService,
    private ai: AiService,
    private typesense: TypesenseService,
    private events: EventsService,
    @InjectQueue('clean') private cleanQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
    private analytics: AnalyticsService,
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
    return this.memoryService.getGraphData(
      ml,
      ll,
      user.id,
      memoryBankId,
      user.memoryBankIds,
      memoryIds,
    );
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
    return this.dbService.withCurrentUser(async (db) => {
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

          // Delete the failed memory (and its links) atomically
          await db.transaction(async (tx) => {
            await tx.delete(memoryContacts).where(eq(memoryContacts.memoryId, mem.id));
            await tx
              .delete(memoryLinks)
              .where(or(eq(memoryLinks.srcMemoryId, mem.id), eq(memoryLinks.dstMemoryId, mem.id)));
            await tx.delete(memories).where(eq(memories.id, mem.id));
          });

          // Re-enqueue through pipeline with generous retries
          await this.cleanQueue.add(
            'clean',
            { rawEventId: rawRows[0].id },
            { attempts: 5, backoff: { type: 'exponential', delay: 10000 } },
          );
          enqueued++;
        } catch (err: unknown) {
          errors++;
          this.logger.error(
            `[retry-failed] ${mem.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return { enqueued, errors, total: failed.length };
    });
  }

  @RequiresJwt()
  @Get('typesense-info')
  async getTypesenseInfo() {
    return this.typesense.getCollectionInfo();
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

    let metadata: Record<string, unknown> = {};
    try {
      metadata =
        typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : memory.metadata || {};
    } catch {
      // metadata may be encrypted ciphertext when user key is not loaded
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: 'encrypted' });
    }

    // Serve from stored thumbnail if available (no upstream fetch needed)
    if (metadata.thumbnailBase64) {
      const buffer = Buffer.from(metadata.thumbnailBase64 as string, 'base64');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(buffer);
    }

    const fileUrl: string | undefined = metadata.fileUrl as string | undefined;
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

    // SSRF guard: validate URL before fetching
    const { validateUrlForFetch } = await import('../utils/ssrf-guard');
    const urlCheck = validateUrlForFetch(thumbUrl);
    if (!urlCheck.valid) {
      return res.status(HttpStatus.FORBIDDEN).json({ error: 'blocked url' });
    }

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

  @ReadOnly()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('search')
  async search(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Body() dto: SearchMemoriesDto,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { results: [], needsRecoveryKey: true };

    // Map typed DTO to SearchFilters
    const filters: Record<string, unknown> = {};
    if (dto.connectorTypes?.length) filters.connectorTypes = dto.connectorTypes;
    if (dto.sourceTypes?.length) filters.sourceTypes = dto.sourceTypes;
    if (dto.factualityLabels?.length) filters.factualityLabels = dto.factualityLabels;
    if (dto.personNames?.length) filters.personNames = dto.personNames;
    if (dto.timeRange?.from) filters.from = dto.timeRange.from;
    if (dto.timeRange?.to) filters.to = dto.timeRange.to;
    if (dto.pinned !== undefined) filters.pinned = dto.pinned;

    const result = await this.memoryService.search(
      dto.query,
      filters as any,
      dto.limit,
      dto.rerank,
      user.id,
      dto.memoryBankId,
      user.memoryBankIds,
    );
    this.analytics.capture(
      'server_search',
      {
        query_length: dto.query.length,
        result_count: result.items.length,
        has_filters: !!(dto.connectorTypes?.length || dto.sourceTypes?.length || dto.timeRange),
        rerank: dto.rerank ?? false,
        memory_bank_id: dto.memoryBankId,
      },
      user.id,
    );

    // Enrich search results with linked people
    if (result.items.length) {
      const peopleMap = await this.memoryService.getPeopleForMemories(
        result.items.map((i) => i.id),
      );
      for (const item of result.items) {
        item.people = peopleMap.get(item.id) || [];
      }
    }
    return result;
  }

  @ReadOnly()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('ask')
  async ask(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Body() dto: AskMemoriesDto,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { answer: '', conversationId: '', citations: [], needsRecoveryKey: true };
    this.analytics.capture(
      'server_ask',
      {
        query_length: dto.query.length,
        has_conversation: !!dto.conversationId,
        memory_bank_id: dto.memoryBankId,
      },
      user.id,
    );
    return this.memoryService.ask(
      dto.query,
      dto.conversationId,
      user.id,
      dto.memoryBankId,
      user.memoryBankIds,
    );
  }

  @RequiresJwt()
  @Post('relabel-unknown')
  async relabelUnknown() {
    return this.dbService.withCurrentUser(async (db) => {
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
        updated:
          ((result1 as unknown as { changes: number }).changes ?? 0) +
          ((result2 as unknown as { changes: number }).changes ?? 0) +
          ((result3 as unknown as { changes: number }).changes ?? 0),
        message: 'Replaced "Unknown" sender labels with "A member" in WhatsApp memories',
      };
    });
  }

  @RequiresJwt()
  @Post(':id/pin')
  async pin(@Param('id') id: string) {
    return this.dbService.withCurrentUser(async (db) => {
      await db.update(memories).set({ pinned: true }).where(eq(memories.id, id));
      return { ok: true };
    });
  }

  @RequiresJwt()
  @Delete(':id/pin')
  async unpin(@Param('id') id: string) {
    return this.dbService.withCurrentUser(async (db) => {
      await db.update(memories).set({ pinned: false }).where(eq(memories.id, id));
      return { ok: true };
    });
  }

  @RequiresJwt()
  @Post(':id/recall')
  async recall(@Param('id') id: string) {
    return this.dbService.withCurrentUser(async (db) => {
      await db
        .update(memories)
        .set({ recallCount: sql`recall_count + 1` })
        .where(eq(memories.id, id));
      return { ok: true };
    });
  }

  @RequiresJwt()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
