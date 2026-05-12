import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getAgentCommand, type AgentToolArg } from '@botmem/shared';
import type { Queue } from 'bullmq';
import { MemoryService } from '../memory/memory.service';
import { AgentService } from '../agent/agent.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { ConnectorsService } from '../connectors/connectors.service';
import type { Request, Response } from 'express';

interface MemoryToolParams {
  query: string;
  source_type?: string;
  connector_type?: string;
  contact_id?: string;
  from_me?: boolean;
  date_from?: string;
  date_to?: string;
  text_max_length?: number;
  limit?: number;
}

interface ListToolParams {
  source_type?: string;
  connector_type?: string;
  from_me?: boolean;
  text_max_length?: number;
  limit?: number;
  offset?: number;
  sort_by?: 'eventTime' | 'ingestTime';
}

interface TimelineToolParams {
  from?: string;
  to?: string;
  query?: string;
  source_type?: string;
  connector_type?: string;
  from_me?: boolean;
  text_max_length?: number;
  limit?: number;
}

interface GetMemoryToolParams {
  id: string;
  text_max_length?: number;
}

const MCP_INSTRUCTIONS = `Botmem is the user's personal memory server. Its nickname is "botmem". When the user asks to use botmem, answer from these Botmem tools before using any other recall, session search, browser, shell, or mailbox tool.

Start with status or sources when you need to discover what connectors, accounts, source types, or queue states are available.

Use list for latest/current-state questions because it can sort by eventTime or ingestTime directly. Use timeline for explicit date ranges. Use search for targeted semantic lookup and browsing of raw memories. Use ask when the user wants a synthesized answer across memories. Use get_memory after another tool returns an id and you need the full record.

Temporal queries are supported. Prefer date_from and date_to with ISO 8601 dates when the user gives a precise range; explicit dates override natural-language dates in the query.

Results are compact by default. Long text fields are returned as excerpts with text_truncated=true; use the memory id for follow-up detail rather than asking for huge result sets.

Start with small limits, then refine by connector_type, source_type, contact_id, date_from, or date_to. source_type="location" is an explicit location stream; GPS-bearing photos remain source_type="photo".

For identifiers such as booking references, PNRs, ticket numbers, invoice numbers, order IDs, or short all-caps codes, run search on the exact identifier with connector_type/source_type filters before paraphrasing. If an exact identifier misses, broaden to the vendor and topic, then list recent memories for the likely connector/source sorted by eventTime or ingestTime. For "latest flight/booking" style questions, prefer recent email memories and inspect eventTime; do not conclude absence until exact-code search and recent connector listing have both failed.`;

const DEFAULT_TEXT_MAX_LENGTH = 500;
const MAX_TEXT_MAX_LENGTH = 2000;
const MCP_SESSION_HEADER = 'mcp-session-id';

interface McpSession {
  userId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private memoryService: MemoryService,
    private agentService: AgentService,
    private dbService: DbService,
    private accountsService: AccountsService,
    private connectorsService: ConnectorsService,
    @InjectQueue('sync') private syncQueue: Queue,
    @InjectQueue('memory') private memoryQueue: Queue,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('enrich') private enrichQueue: Queue,
    @InjectQueue('maintenance') private maintenanceQueue: Queue,
  ) {}

  async onModuleDestroy() {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.transport.close().catch(() => {})),
    );
    this.sessions.clear();
  }

  async handleRequest(req: Request, res: Response, userId: string): Promise<void> {
    await this.handleStatefulRequest(req, res, userId, false);
  }

  handleSseStream(req: Request, res: Response, userId: string, clientId: string): void {
    const session = this.getExistingSession(req, res, userId);
    if (session) {
      session.transport.handleRequest(req, res, req.body).catch((err: unknown) => {
        this.logger.error(
          `MCP SSE handleRequest error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        if (!res.headersSent) res.status(500).json({ error: 'Internal MCP error' });
      });
      return;
    }

    if (this.requestSessionId(req)) return;

    const startedAt = Date.now();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': botmem-ready\n\n');

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.logger.debug(
        JSON.stringify({
          event: 'mcp.sse_closed',
          method: req.method,
          path: req.originalUrl,
          userId,
          clientId,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
  }

  async terminateSession(req: Request, res: Response, userId: string): Promise<void> {
    const sessionId = this.requestSessionId(req);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        res.status(404).json({ error: 'Unknown MCP session' });
        return;
      }
      this.sessions.delete(sessionId);
      await session.transport.close().catch(() => {});
    }
    res.status(200).json({ ok: true });
  }

  private async handleStatefulRequest(
    req: Request,
    res: Response,
    userId: string,
    enableJsonResponse: boolean,
  ): Promise<void> {
    this.attachRequestLog(req, res, userId);
    const existingSession = this.getExistingSession(req, res, userId);
    if (existingSession) {
      await existingSession.transport.handleRequest(req, res, req.body);
      return;
    }
    if (this.requestSessionId(req)) return;

    const session = await this.createSession(userId, enableJsonResponse);
    await session.transport.handleRequest(req, res, req.body);
    const sessionId = session.transport.sessionId;
    if (sessionId) this.sessions.set(sessionId, session);
  }

  private async createSession(userId: string, enableJsonResponse: boolean): Promise<McpSession> {
    const server = this.createServer(userId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse,
    });

    transport.onerror = (err: Error) => {
      this.logger.error(`MCP transport error: ${err.message}`, err.stack);
    };
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    return { userId, server, transport };
  }

  private getExistingSession(req: Request, res: Response, userId: string): McpSession | null {
    const sessionId = this.requestSessionId(req);
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Unknown MCP session' });
      return null;
    }
    return session;
  }

  private requestSessionId(req: Request): string | null {
    const value = req.headers?.[MCP_SESSION_HEADER];
    if (Array.isArray(value)) return value[0] || null;
    return value || null;
  }

  private attachRequestLog(req: Request, res: Response, userId: string): void {
    const startedAt = Date.now();
    const body = req.body as
      | {
          method?: string;
          params?: { name?: string };
        }
      | undefined;

    res.on('finish', () => {
      this.logger.log(
        JSON.stringify({
          event: 'mcp.request',
          method: req.method,
          path: req.originalUrl,
          rpcMethod: body?.method,
          toolName: body?.params?.name,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          userId,
          traceId: res.getHeader('x-trace-id'),
        }),
      );
    });
  }

  private createServer(userId: string): McpServer {
    const server = new McpServer(
      {
        name: 'Botmem',
        version: '1.0.0',
        icons: [
          {
            src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAD2klEQVR4nO3cv2oUURTH8bsaY8CQBEEIlimz5AEiFmkVbJQ8g49gu2Dno6TwFQRt0mu2NK0gyBoSIuaf5xZb7MydccWZ+7vZ8/2A4+0Oc88XxOA4mEwmNwELa2NjY2C/NSKABTd3ACcnJ2E8HtsJt9Ha2lrY3t6206y5Azg8PAz7+/t2wm20u7sbDg4O7DSLAJwgAOcIwDkCcI4AnCMA5wjAuaYAxvdf7IUWBLAgmgL4cu+5PZsRwD/a2Xllz7yOjz+G09PvdmqWNYDXbx+HreGKnfr35uVXe85SzicA8+79Vth58sBO/Xu2+dmes5TzpwHc3FyHy8vfdurHYHAnLC0t24kA7DlLOX8awMXFrzCZfLNTP5aXV8L6+qadCMCes5TzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLlfAIwygVEyvkEYJQLiJTzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLlfAIwygVEyvkEYJQLiJTzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLl/GkA8ZuAs7MfdurH3bvLYXX1oZ0IwJ6zlPOnAeRUXACeEYBzq6uP7JnX+fnPcHXV/hkaAThHAM5lC6DUPwNzKfX9XQXA/w9Qlz0A5ffxJfw1UPn+KdkDUP4krIQAlO+fQgA9IYCKEi6AAOoIoCcEUFHCBRBAHQH0hAAqSrgAAqgjgJ4QQEUJF0AAdQTQEwKoKOECCKCOAHpCABUlXAAB1BFATwigooQLIIA6AugJAVSUcAEEUEcAPSGAihIugADqCKAnBFBRwgUQQB0B9IQAKkq4AAKoyx5A/Dfxqu/jSwhA+f4p2QPIqXoBJQSQU/X9U1wFoFTq+2cLoNTv43Mp9f2zBYAyEYBzbgIo9c9gtawBeP8+X/n+TbIGUMJfw5Tf5yvfv4m7AJQ/iVO+fxMC6BgBtFBeAAGkEUDHCKCF8gIIII0AOkYALZQXQABpBNAxAmihvAACSCOAjhFAC+UFEEAaAXSMAFooL4AA0gigYwTQQnkBBJBGAB0jgBbKCyCANALoGAG0UF4AAaQRQMcIoIXyAgggjQA6RgAtlBdAAGnuAojfBKi+z1e+fxN3AeREAAUpIYASuQmg1O/z1dwEgDQCcI4AnCMA5wjAOQJwjgCcIwDn/juAo6OjMBqNAm6n4XAYRon9zR0AFhMBOEcAzhGAcwTg3F8DsF9z+XT+dG9wff3BjlggBOAcAThHAM4RgHME4BwBOEcAzv0Bdf3T+USC1UsAAAAASUVORK5CYII=',
            mimeType: 'image/png',
            sizes: ['128x128'],
          },
        ],
      },
      { instructions: MCP_INSTRUCTIONS },
    );

    this.registerTools(server, userId);
    return server;
  }

  // ── Tool helpers ──────────────────────────────────────────────────

  /** Check if user's DEK is available; return error content if not */
  private async checkDek(
    userId: string,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: true } | null> {
    const needsKey = await this.memoryService.needsRecoveryKey(userId);
    if (needsKey) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: Recovery key required. Your encryption key is not cached. Please re-authorize via the web UI or POST /api/user-auth/recovery-key before using MCP tools that access encrypted data.',
          },
        ],
        isError: true,
      };
    }
    return null;
  }

  private buildSearchFilters(params: {
    source_type?: string;
    connector_type?: string;
    contact_id?: string;
    date_from?: string;
    date_to?: string;
    from_me?: boolean;
  }): {
    sourceType?: string;
    connectorType?: string;
    contactId?: string;
    from?: string;
    to?: string;
    fromMe?: boolean;
  } {
    return {
      sourceType: params.source_type,
      connectorType: params.connector_type,
      contactId: params.contact_id,
      from: params.date_from,
      to: params.date_to,
      fromMe: params.from_me,
    };
  }

  private normalizeTextMaxLength(value: number | undefined): number {
    if (!Number.isFinite(value)) return DEFAULT_TEXT_MAX_LENGTH;
    return Math.max(0, Math.min(Math.floor(value ?? DEFAULT_TEXT_MAX_LENGTH), MAX_TEXT_MAX_LENGTH));
  }

  private formatMcpResponse(data: unknown, textMaxLength?: number): string {
    const shaped = this.shapeMcpPayload(data, this.normalizeTextMaxLength(textMaxLength));
    return JSON.stringify(shaped, null, 2);
  }

  private shapeMcpPayload(data: unknown, textMaxLength: number): unknown {
    if (!data || typeof data !== 'object') return data;
    if (data instanceof Date) return data.toISOString();

    if (Array.isArray(data)) {
      return this.dedupeMemories(data).map((item) => this.shapeMcpPayload(item, textMaxLength));
    }

    const obj = data as Record<string, unknown>;
    const shaped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'searchTokens' || key === 'search_tokens') {
        continue;
      }
      if ((key === 'items' || key === 'results') && Array.isArray(value)) {
        shaped[key] = this.dedupeMemories(value).map((item) =>
          this.shapeMcpPayload(item, textMaxLength),
        );
        continue;
      }
      shaped[key] = this.shapeMcpPayload(value, textMaxLength);
    }

    if (shaped.connectorType === 'photos') {
      shaped.metadata = this.withPhotoTakenAt(shaped.metadata, shaped.eventTime);
    }
    if ('metadata' in shaped) {
      shaped.metadata = this.memoryService.sanitizeMemoryMetadataForResponse(shaped.metadata);
    }

    if (
      typeof shaped.text === 'string' &&
      textMaxLength >= 0 &&
      shaped.text.length > textMaxLength
    ) {
      shaped.text = shaped.text.slice(0, textMaxLength).trimEnd();
      shaped.text_truncated = true;
    }

    return shaped;
  }

  private withPhotoTakenAt(metadata: unknown, eventTime: unknown): unknown {
    const metadataObject = this.parseMaybeJsonObject(metadata);
    if (!Object.keys(metadataObject).length && metadata !== undefined && metadata !== null) {
      return metadata;
    }
    if (!metadataObject.takenAt && typeof eventTime === 'string' && eventTime.trim()) {
      metadataObject.takenAt = eventTime;
    }
    return metadataObject;
  }

  private dedupeMemories(items: unknown[]): unknown[] {
    const out: unknown[] = [];
    const byKey = new Map<string, Record<string, unknown>>();

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        out.push(item);
        continue;
      }
      const obj = { ...(item as Record<string, unknown>) };
      const key = this.memoryDedupeKey(obj);
      if (!key) {
        out.push(item);
        continue;
      }

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, obj);
        out.push(obj);
        continue;
      }

      const duplicateCount = Number(existing.duplicate_count ?? 1) + 1;
      if (Number(obj.score ?? 0) > Number(existing.score ?? 0)) {
        Object.assign(existing, obj);
      }
      existing.duplicate_count = duplicateCount;
    }

    return out;
  }

  private memoryDedupeKey(item: Record<string, unknown>): string | null {
    if (!('id' in item) || !('connectorType' in item)) return null;

    const connector = String(item.connectorType ?? '');
    const metadata = this.parseMaybeJsonObject(item.metadata);
    const messageId = this.firstString(metadata, ['messageId', 'message_id', 'internetMessageId']);
    if (messageId) return `${connector}:message:${messageId}`;

    const threadId = this.firstString(metadata, ['threadId', 'thread_id']);
    const eventTime = item.eventTime ? String(item.eventTime) : '';
    const textPrefix = typeof item.text === 'string' ? item.text.slice(0, 200).toLowerCase() : '';
    if (threadId && eventTime && textPrefix) {
      return `${connector}:thread:${threadId}:${eventTime}:${textPrefix}`;
    }

    return String(item.id);
  }

  private parseMaybeJsonObject(value: unknown): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private firstString(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private ok(data: unknown, textMaxLength?: number) {
    return {
      content: [
        {
          type: 'text' as const,
          text: this.formatMcpResponse(data, textMaxLength),
        },
      ],
    };
  }

  private error(err: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true as const,
    };
  }

  private summarizeAccount(account: unknown): Record<string, unknown> {
    const row = account as Record<string, unknown>;
    return {
      id: row.id,
      connectorType: row.connectorType,
      identifier: row.identifier,
      status: row.status,
      schedule: row.schedule,
      tunnelMode: row.tunnelMode,
      lastSyncAt: row.lastSyncAt,
      itemsSynced: row.itemsSynced,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    };
  }

  private summarizeConnector(connector: unknown): Record<string, unknown> {
    const manifest = connector as Record<string, unknown>;
    return {
      id: manifest.id,
      name: manifest.name,
      authType: manifest.authType,
      version: manifest.version,
      description: manifest.description,
      trustScore: manifest.trustScore,
      entities: manifest.entities,
      configSchema: manifest.configSchema,
    };
  }

  private maxIso(values: unknown[]): string | null {
    let max = 0;
    for (const value of values) {
      const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
      if (Number.isFinite(time) && time > max) max = time;
    }
    return max ? new Date(max).toISOString() : null;
  }

  private async getQueueStats() {
    const queues: Array<[string, Queue]> = [
      ['sync', this.syncQueue],
      ['memory', this.memoryQueue],
      ['embed', this.embedQueue],
      ['enrich', this.enrichQueue],
      ['maintenance', this.maintenanceQueue],
    ];
    const entries = await Promise.all(
      queues.map(async ([name, queue]) => {
        try {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          return [name, counts] as const;
        } catch (err: unknown) {
          return [name, { error: err instanceof Error ? err.message : String(err) }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private normalizeListSort(value: unknown): 'eventTime' | 'ingestTime' {
    return value === 'ingestTime' ? 'ingestTime' : 'eventTime';
  }

  // ── Tool registration ─────────────────────────────────────────────

  private mcpToolName(commandId: string): string {
    return getAgentCommand(commandId)?.mcp?.name ?? commandId;
  }

  private mcpToolDescription(commandId: string): string {
    return getAgentCommand(commandId)?.mcp?.description ?? commandId;
  }

  private mcpToolSchema(commandId: string): Record<string, z.ZodTypeAny> {
    const args = getAgentCommand(commandId)?.mcp?.args ?? {};
    return Object.fromEntries(
      Object.entries(args).map(([name, arg]) => [name, this.zodArgSchema(arg)]),
    );
  }

  private zodArgSchema(arg: AgentToolArg): z.ZodTypeAny {
    let schema: z.ZodTypeAny =
      arg.type === 'number' ? z.number() : arg.type === 'boolean' ? z.boolean() : z.string();

    if (arg.type === 'number') {
      if (typeof arg.min === 'number') schema = (schema as z.ZodNumber).min(arg.min);
      if (typeof arg.max === 'number') schema = (schema as z.ZodNumber).max(arg.max);
    }

    if (!arg.required) schema = schema.optional();
    if (arg.default !== undefined) schema = schema.default(arg.default);
    return schema.describe(arg.description);
  }

  private registerTools(server: McpServer, userId: string) {
    const registerTool = server.tool.bind(server) as unknown as (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (params: unknown) => Promise<unknown>,
    ) => void;

    registerTool(
      this.mcpToolName('search'),
      this.mcpToolDescription('search'),
      this.mcpToolSchema('search'),
      async (rawParams) => {
        const params = rawParams as unknown as MemoryToolParams;
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const results = await this.dbService.withUserId(userId, async () => {
            return this.memoryService.search(
              params.query,
              this.buildSearchFilters(params),
              params.limit,
              userId,
            );
          });
          return this.ok(results, params.text_max_length);
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('ask'),
      this.mcpToolDescription('ask'),
      this.mcpToolSchema('ask'),
      async (rawParams) => {
        const params = rawParams as unknown as MemoryToolParams;
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const result = await this.dbService.withUserId(userId, async () => {
            return this.agentService.ask(params.query, {
              filters: this.buildSearchFilters(params),
              limit: params.limit,
              userId,
            });
          });
          return this.ok(result, params.text_max_length);
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('status'),
      this.mcpToolDescription('status'),
      this.mcpToolSchema('status'),
      async () => {
        try {
          const [stats, accounts, queues] = await this.dbService.withUserId(userId, async () =>
            Promise.all([
              this.memoryService.getStats(userId),
              this.accountsService.getAll(userId),
              this.getQueueStats(),
            ]),
          );
          const summarizedAccounts = accounts.map((account) => this.summarizeAccount(account));
          const lastUpdate = this.maxIso(
            summarizedAccounts.flatMap((account) => [account.lastSyncAt, account.updatedAt]),
          );
          return this.ok({
            memory: stats,
            accounts: summarizedAccounts,
            connectors: this.connectorsService
              .list()
              .map((connector) => this.summarizeConnector(connector)),
            queues,
            lastUpdate,
          });
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('sources'),
      this.mcpToolDescription('sources'),
      this.mcpToolSchema('sources'),
      async () => {
        try {
          const stats = await this.dbService.withUserId(userId, async () =>
            this.memoryService.getStats(userId),
          );
          return this.ok({
            sourceTypes: stats.bySource,
            connectorTypes: stats.byConnector,
            factuality: stats.byFactuality,
            total: stats.total,
            connectors: this.connectorsService
              .list()
              .map((connector) => this.summarizeConnector(connector)),
          });
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('memories'),
      this.mcpToolDescription('memories'),
      this.mcpToolSchema('memories'),
      async (rawParams) => {
        const params = rawParams as unknown as ListToolParams;
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const result = await this.dbService.withUserId(userId, async () =>
            this.memoryService.list({
              connectorType: params.connector_type,
              sourceType: params.source_type,
              limit: params.limit,
              offset: params.offset,
              sortBy: this.normalizeListSort(params.sort_by),
              userId,
              fromMe: params.from_me,
            }),
          );
          return this.ok(result, params.text_max_length);
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('timeline'),
      this.mcpToolDescription('timeline'),
      this.mcpToolSchema('timeline'),
      async (rawParams) => {
        const params = rawParams as unknown as TimelineToolParams;
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const result = await this.dbService.withUserId(userId, async () =>
            this.memoryService.timeline({
              from: params.from,
              to: params.to,
              query: params.query,
              connectorType: params.connector_type,
              sourceType: params.source_type,
              limit: params.limit,
              userId,
              fromMe: params.from_me,
            }),
          );
          return this.ok(result, params.text_max_length);
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );

    registerTool(
      this.mcpToolName('memory'),
      this.mcpToolDescription('memory'),
      this.mcpToolSchema('memory'),
      async (rawParams) => {
        const params = rawParams as unknown as GetMemoryToolParams;
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const result = await this.dbService.withUserId(userId, async () =>
            this.memoryService.getById(params.id, userId),
          );
          if (!result) return this.error(`Memory not found: ${params.id}`);
          return this.ok(result, params.text_max_length);
        } catch (err: unknown) {
          return this.error(err);
        }
      },
    );
  }
}
