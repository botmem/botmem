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
import { PgSearchService } from './pg-search.service';
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
    private searchIndex: PgSearchService,
    private events: EventsService,
    @InjectQueue('memory') private memoryQueue: Queue,
    private analytics: AnalyticsService,
  ) {}

  @Get('stats')
  async getStats(@CurrentUser() user: { id: string; memoryBankIds?: string[] }) {
    // Proactively validate DEK on first data request — evicts stale keys
    const dekInvalid = await this.memoryService.validateDek(user.id);
    const stats = await this.memoryService.getStats(user.id, user.memoryBankIds);
    const needsRecoveryKey = dekInvalid || (await this.memoryService.needsRecoveryKey(user.id));
    return { ...stats, needsRecoveryKey };
  }

  @RequiresJwt()
  @Get('queue-status')
  async getQueueStatus() {
    const [waiting, active, failed, delayed, completed] = await Promise.all([
      this.memoryQueue.getWaitingCount(),
      this.memoryQueue.getActiveCount(),
      this.memoryQueue.getFailedCount(),
      this.memoryQueue.getDelayedCount(),
      this.memoryQueue.getCompletedCount(),
    ]);
    const counts = { waiting, active, failed, delayed, completed };
    return {
      memory: counts,
      clean: counts,
      embed: counts,
      enrich: counts,
    };
  }

  @Get('graph')
  async getGraphData(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Query('memoryLimit', new DefaultValuePipe(40), ParseIntPipe) memoryLimit: number,
    @Query('linkLimit', new DefaultValuePipe(120), ParseIntPipe) linkLimit: number,
    @Query('memoryBankId') memoryBankId?: string,
    @Query('memoryIds') memoryIdsParam?: string,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { nodes: [], edges: [], needsRecoveryKey: true };
    const memoryIds = memoryIdsParam ? memoryIdsParam.split(',').filter(Boolean) : undefined;
    const ml = Math.min(memoryLimit, memoryIds?.length ? 250 : 80);
    const ll = Math.min(linkLimit, memoryIds?.length ? 1000 : 240);
    return this.memoryService.getGraphData(
      ml,
      ll,
      user.id,
      memoryBankId,
      user.memoryBankIds,
      memoryIds,
    );
  }

  @Get('graph/neighbors/:nodeId')
  async getGraphNeighbors(
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Param('nodeId') nodeId: string,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('memoryBankId') memoryBankId?: string,
  ) {
    if (await this.memoryService.needsRecoveryKey(user.id))
      return { nodes: [], edges: [], needsRecoveryKey: true };
    return this.memoryService.getGraphNeighbors(
      decodeURIComponent(nodeId),
      Math.min(limit, 50),
      user.id,
      memoryBankId,
      user.memoryBankIds,
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
          await this.memoryQueue.add(
            'process',
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
  @Get('raw-events/debt')
  async rawEventDebt(
    @CurrentUser() user: { id: string },
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
  ) {
    const filters = [
      sql`a.user_id = ${user.id}`,
      sql`re.processing_state IN ('pending', 'failed')`,
      sql`re.source_type NOT IN ('contact', 'group')`,
      sql`NOT (re.connector_type = 'telegram' AND re.source_id LIKE 'telegram:contact:%')`,
      sql`NOT EXISTS (
        SELECT 1 FROM memories m
        WHERE m.source_id = re.source_id AND m.connector_type = re.connector_type
      )`,
    ];
    if (connectorType) filters.push(sql`re.connector_type = ${connectorType}`);
    if (sourceType) filters.push(sql`re.source_type = ${sourceType}`);

    const result = await this.dbService.db.execute(sql`
      SELECT
        re.connector_type AS "connectorType",
        re.source_type AS "sourceType",
        re.processing_state AS "processingState",
        count(*)::int AS count
      FROM raw_events re
      INNER JOIN accounts a ON a.id = re.account_id
      WHERE ${sql.join(filters, sql` AND `)}
      GROUP BY re.connector_type, re.source_type, re.processing_state
      ORDER BY count DESC
    `);

    const groups = result.rows as Array<{
      connectorType: string;
      sourceType: string;
      processingState: string;
      count: number;
    }>;
    return {
      total: groups.reduce((sum, row) => sum + Number(row.count || 0), 0),
      groups,
    };
  }

  @RequiresJwt()
  @Post('raw-events/repair')
  async repairRawEventDebt(
    @CurrentUser() user: { id: string },
    @Query('limit') limitParam?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
  ) {
    const limit = Math.min(parseInt(limitParam || '200', 10) || 200, 10000);
    const filters = [
      sql`a.user_id = ${user.id}`,
      sql`re.processing_state IN ('pending', 'failed')`,
      sql`re.source_type NOT IN ('contact', 'group')`,
      sql`NOT (re.connector_type = 'telegram' AND re.source_id LIKE 'telegram:contact:%')`,
      sql`NOT EXISTS (
        SELECT 1 FROM memories m
        WHERE m.source_id = re.source_id AND m.connector_type = re.connector_type
      )`,
    ];
    if (connectorType) filters.push(sql`re.connector_type = ${connectorType}`);
    if (sourceType) filters.push(sql`re.source_type = ${sourceType}`);

    const result = await this.dbService.db.execute(sql`
      SELECT re.id
      FROM raw_events re
      INNER JOIN accounts a ON a.id = re.account_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY re.created_at ASC
      LIMIT ${limit}
    `);

    let enqueued = 0;
    for (const row of result.rows as Array<{ id: string }>) {
      await this.memoryQueue.add(
        'process',
        { rawEventId: row.id },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: `repair:${row.id}`,
        },
      );
      enqueued++;
    }

    return {
      enqueued,
      limit,
      connectorType: connectorType ?? null,
      sourceType: sourceType ?? null,
    };
  }

  @RequiresJwt()
  @Get('search-index-info')
  async getSearchIndexInfo() {
    return this.searchIndex.getCollectionInfo();
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
    @CurrentUser() user: { id: string },
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
    return this.memoryService.searchEntities(
      q,
      limit ? parseInt(limit, 10) : undefined,
      types,
      user.id,
    );
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

    const metadata: Record<string, unknown> = (() => {
      try {
        return typeof memory.metadata === 'string'
          ? JSON.parse(memory.metadata)
          : memory.metadata || {};
      } catch {
        return null;
      }
    })();
    if (!metadata) return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: 'encrypted' });

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
  async getRelated(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    // IDOR fix: verify memory belongs to user before returning related
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return { items: [], source: null };
    return this.memoryService.getRelated(id, limit ? parseInt(limit, 10) : undefined);
  }

  @ReadOnly()
  @Get(':id/raw')
  async getRaw(
    @Param('id') id: string,
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
  ) {
    return this.memoryService.getRawById(id, user.id, user.memoryBankIds);
  }

  @ReadOnly()
  @Get(':id/raw/file')
  async getRawFile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string; memoryBankIds?: string[] },
    @Query('variant') variant: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const asset = await this.memoryService.getRawAssetById(
        id,
        user.id,
        user.memoryBankIds,
        variant === 'thumbnail' ? 'thumbnail' : 'original',
      );
      if (!asset) return res.status(HttpStatus.NOT_FOUND).json({ error: 'not found' });
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asset.fileName.replace(/"/g, '')}"`,
      );
      if (asset.contentLength != null) res.setHeader('Content-Length', String(asset.contentLength));
      return res.send(asset.buffer);
    } catch (err) {
      return res.status(HttpStatus.BAD_GATEWAY).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      return { items: [], fallback: false, needsRecoveryKey: true };

    // Map typed DTO to SearchFilters
    const filters: Record<string, unknown> = {};
    if (dto.filters && typeof dto.filters === 'object') Object.assign(filters, dto.filters);
    if (dto.connectorType) filters.connectorType = dto.connectorType;
    if (dto.sourceType) filters.sourceType = dto.sourceType;
    if (dto.contactId) filters.contactId = dto.contactId;
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
      user.id,
      dto.memoryBankId,
      user.memoryBankIds,
      dto.diversityFactor,
      { debug: dto.debug },
    );
    this.analytics.capture(
      'server_search',
      {
        query_length: dto.query.length,
        result_count: result.items.length,
        has_filters: !!(dto.connectorTypes?.length || dto.sourceTypes?.length || dto.timeRange),
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

  @RequiresJwt()
  @Get('index/schema')
  async getSearchIndexSchema() {
    return this.searchIndex.getSchemaStatus();
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
  async relabelUnknown(@CurrentUser() user: { id: string }) {
    return this.dbService.withCurrentUser(async (db) => {
      // Replace "Unknown:" with "A member:" and "Unknown sent" with "A member sent" in WhatsApp memories
      const result1 = await db.execute(sql`
        UPDATE memories m SET text = REPLACE(text, 'Unknown:', 'A member:')
        FROM accounts a
        WHERE m.account_id = a.id AND a.user_id = ${user.id}
          AND m.connector_type = 'whatsapp' AND m.text LIKE '%Unknown:%'
      `);
      const result2 = await db.execute(sql`
        UPDATE memories m SET text = REPLACE(text, 'Unknown sent', 'A member sent')
        FROM accounts a
        WHERE m.account_id = a.id AND a.user_id = ${user.id}
          AND m.connector_type = 'whatsapp' AND m.text LIKE '%Unknown sent%'
      `);
      const result3 = await db.execute(sql`
        UPDATE memories m SET text = REPLACE(text, 'Unknown shared', 'A member shared')
        FROM accounts a
        WHERE m.account_id = a.id AND a.user_id = ${user.id}
          AND m.connector_type = 'whatsapp' AND m.text LIKE '%Unknown shared%'
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
  async pin(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify memory belongs to user
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return { error: 'not found' };
    return this.dbService.withCurrentUser(async (db) => {
      await db.update(memories).set({ pinned: true }).where(eq(memories.id, id));
      return { ok: true };
    });
  }

  @RequiresJwt()
  @Delete(':id/pin')
  async unpin(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify memory belongs to user
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return { error: 'not found' };
    return this.dbService.withCurrentUser(async (db) => {
      await db.update(memories).set({ pinned: false }).where(eq(memories.id, id));
      return { ok: true };
    });
  }

  @RequiresJwt()
  @Post(':id/recall')
  async recall(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify memory belongs to user
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return { error: 'not found' };
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
  async delete(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // IDOR fix: verify memory belongs to user
    const memory = await this.memoryService.getById(id, user.id);
    if (!memory) return { error: 'not found' };
    await this.memoryService.delete(id);
    return { ok: true };
  }
}
