import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  NotFoundException,
  ParseIntPipe,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AskDto } from './dto/ask.dto';
import { ReadOnly } from '../user-auth/decorators/read-only.decorator';
import { RememberDto } from './dto/remember.dto';
import { SummarizeDto } from './dto/summarize.dto';

// ── Response wrapper ─────────────────────────────────────────────────

function ok<T>(data: T, meta?: { queryTime: number; resultCount: number; sources: string[] }) {
  return { success: true as const, data, meta };
}

// ── Controller ───────────────────────────────────────────────────────

@ApiTags('Agent')
@ApiBearerAuth()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Natural language memory search with enriched results. */
  @ReadOnly()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('ask')
  @HttpCode(200)
  async ask(@CurrentUser() user: { id: string }, @Body() dto: AskDto) {
    const start = Date.now();
    const result = await this.agentService.ask(dto.query, {
      filters: dto.filters,
      limit: dto.limit,
      userId: user.id,
    });

    const sources = [...new Set(result.results.map((r) => r.connectorType))];
    this.analytics.capture(
      'agent_ask',
      {
        query_length: dto.query.length,
        result_count: result.results.length,
        query_time_ms: Date.now() - start,
        sources,
      },
      user.id,
    );
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: result.results.length,
      sources,
    });
  }

  /** Chronological memory retrieval with optional filters. */
  @Get('timeline')
  async timeline(
    @Query('contactId') contactId?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('days', new ParseIntPipe({ optional: true })) days?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const start = Date.now();

    const result = await this.agentService.timeline({
      contactId,
      connectorType,
      sourceType,
      days,
      limit,
    });

    const allMems = Object.values(result.results).flat();
    const sources = [...new Set(allMems.map((r) => r.connectorType))];
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: result.totalCount,
      sources,
    });
  }

  /** Quick memory insertion from agent. */
  @RequiresJwt()
  @Post('remember')
  async remember(@Body() dto: RememberDto) {
    const start = Date.now();
    const result = await this.agentService.remember(dto.text, dto.metadata);
    this.analytics.capture('agent_remember', {
      text_length: dto.text.length,
    });
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: 1,
      sources: ['agent'],
    });
  }

  /** Delete a memory and its vector. */
  @RequiresJwt()
  @Delete('forget/:id')
  async forget(@Param('id') id: string) {
    const start = Date.now();
    const result = await this.agentService.forget(id);
    if (!result.deleted) {
      throw new NotFoundException('Memory not found');
    }
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: 0,
      sources: [],
    });
  }

  /** Full context about a person: contact details, identifiers, recent memories, stats. */
  @Get('context/:contactId')
  async context(@Param('contactId') contactId: string) {
    const start = Date.now();
    const result = await this.agentService.context(contactId);
    if (!result) {
      throw new NotFoundException('Contact not found');
    }

    const sources = [...new Set(result.recentMemories.map((r) => r.connectorType))];
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: result.recentMemories.length,
      sources,
    });
  }

  /** Search + LLM summarization of matching memories. */
  @ReadOnly()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('summarize')
  @HttpCode(200)
  async summarize(@CurrentUser() user: { id: string }, @Body() dto: SummarizeDto) {
    const start = Date.now();
    const result = await this.agentService.summarize(dto.query, dto.maxResults, user.id);
    this.analytics.capture(
      'agent_summarize',
      {
        query_length: dto.query.length,
        result_count: result.memories.length,
        query_time_ms: Date.now() - start,
      },
      user.id,
    );

    const sources = [...new Set(result.memories.map((r) => r.connectorType))];
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: result.memories.length,
      sources,
    });
  }

  /** System health: memory count, contact count, model info. */
  @Get('status')
  async status() {
    const start = Date.now();
    const result = await this.agentService.status();
    return ok(result, {
      queryTime: Date.now() - start,
      resultCount: result.memories.total,
      sources: Object.keys(result.memories.byConnector),
    });
  }
}
