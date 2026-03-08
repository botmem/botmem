import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { RequiresJwt } from '../user-auth/decorators/requires-jwt.decorator';

// ── Response wrapper ─────────────────────────────────────────────────

function ok<T>(data: T, meta?: { queryTime: number; resultCount: number; sources: string[] }) {
  return { success: true as const, data, meta };
}

function fail(error: string) {
  return { success: false as const, error };
}

// ── Controller ───────────────────────────────────────────────────────

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /** Natural language memory search with enriched results. */
  @RequiresJwt()
  @Post('ask')
  @HttpCode(200)
  async ask(
    @Body() body: { query?: string; filters?: { sourceType?: string; connectorType?: string; contactId?: string }; limit?: number },
  ) {
    const start = Date.now();
    try {
      if (!body.query?.trim()) return fail('query is required');

      const result = await this.agentService.ask(body.query, {
        filters: body.filters,
        limit: body.limit,
      });

      const sources = [...new Set(result.results.map((r) => r.connectorType))];
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: result.results.length,
        sources,
      });
    } catch (err: any) {
      return fail(err.message || 'ask failed');
    }
  }

  /** Chronological memory retrieval with optional filters. */
  @Get('timeline')
  async timeline(
    @Query('contactId') contactId?: string,
    @Query('connectorType') connectorType?: string,
    @Query('sourceType') sourceType?: string,
    @Query('days') daysStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    const start = Date.now();
    try {
      const days = daysStr ? parseInt(daysStr, 10) : undefined;
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

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
    } catch (err: any) {
      return fail(err.message || 'timeline failed');
    }
  }

  /** Quick memory insertion from agent. */
  @RequiresJwt()
  @Post('remember')
  async remember(
    @Body() body: { text?: string; metadata?: Record<string, unknown> },
  ) {
    const start = Date.now();
    try {
      if (!body.text?.trim()) return fail('text is required');

      const result = await this.agentService.remember(body.text, body.metadata);
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: 1,
        sources: ['agent'],
      });
    } catch (err: any) {
      return fail(err.message || 'remember failed');
    }
  }

  /** Delete a memory and its vector. */
  @RequiresJwt()
  @Delete('forget/:id')
  async forget(@Param('id') id: string) {
    const start = Date.now();
    try {
      const result = await this.agentService.forget(id);
      if (!result.deleted) return fail('memory not found');
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: 0,
        sources: [],
      });
    } catch (err: any) {
      return fail(err.message || 'forget failed');
    }
  }

  /** Full context about a person: contact details, identifiers, recent memories, stats. */
  @Get('context/:contactId')
  async context(@Param('contactId') contactId: string) {
    const start = Date.now();
    try {
      const result = await this.agentService.context(contactId);
      if (!result) return fail('contact not found');

      const sources = [...new Set(result.recentMemories.map((r) => r.connectorType))];
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: result.recentMemories.length,
        sources,
      });
    } catch (err: any) {
      return fail(err.message || 'context failed');
    }
  }

  /** Search + LLM summarization of matching memories. */
  @RequiresJwt()
  @Post('summarize')
  @HttpCode(200)
  async summarize(
    @Body() body: { query?: string; maxResults?: number },
  ) {
    const start = Date.now();
    try {
      if (!body.query?.trim()) return fail('query is required');

      const result = await this.agentService.summarize(body.query, body.maxResults);

      const sources = [...new Set(result.memories.map((r) => r.connectorType))];
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: result.memories.length,
        sources,
      });
    } catch (err: any) {
      return fail(err.message || 'summarize failed');
    }
  }

  /** System health: memory count, contact count, model info. */
  @Get('status')
  async status() {
    const start = Date.now();
    try {
      const result = await this.agentService.status();
      return ok(result, {
        queryTime: Date.now() - start,
        resultCount: result.memories.total,
        sources: Object.keys(result.memories.byConnector),
      });
    } catch (err: any) {
      return fail(err.message || 'status failed');
    }
  }
}
