import { Injectable, Logger, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MemoryService } from '../memory/memory.service';
import { AgentService } from '../agent/agent.service';
import { DbService } from '../db/db.service';
import type { Request, Response } from 'express';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastAccess: number;
  userId: string;
}

const MCP_INSTRUCTIONS = `Botmem is the user's personal memory server. Its nickname is "botmem".

Use search for targeted lookup and browsing of raw memories. Use ask when the user wants a synthesized answer across memories.

Temporal queries are supported. Prefer date_from and date_to with ISO 8601 dates when the user gives a precise range; explicit dates override natural-language dates in the query.

Results are compact by default. Long text fields are returned as excerpts with text_truncated=true; use the memory id for follow-up detail rather than asking for huge result sets.

Start with small limits, then refine by connector_type, source_type, contact_id, date_from, or date_to.`;

const DEFAULT_TEXT_MAX_LENGTH = 500;
const MAX_TEXT_MAX_LENGTH = 2000;

@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private sessions = new Map<string, McpSession>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private memoryService: MemoryService,
    private agentService: AgentService,
    private dbService: DbService,
  ) {
    // Cleanup expired sessions every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupInterval);
    for (const [id, session] of this.sessions) {
      session.transport.close();
      this.sessions.delete(id);
    }
  }

  async handleRequest(req: Request, res: Response, userId: string): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (session.userId !== userId) {
        throw new UnauthorizedException('Session user mismatch');
      }
      session.lastAccess = Date.now();
      this.logger.debug(
        `MCP request on session ${sessionId}: ${JSON.stringify(req.body?.method || req.body)}`,
      );
      try {
        await session.transport.handleRequest(req, res, req.body);
      } catch (err: unknown) {
        this.logger.error(
          `MCP session ${sessionId} handleRequest error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal MCP error' });
        }
      }
      return;
    }

    // New session: POST without session ID (initialization)
    if (req.method === 'POST' && !sessionId) {
      const server = this.createServer(userId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          this.sessions.set(newSessionId, {
            server,
            transport,
            lastAccess: Date.now(),
            userId,
          });
          this.logger.log(`MCP session created: ${newSessionId} for user ${userId}`);
        },
      });

      transport.onclose = () => {
        this.logger.warn(`MCP transport closed unexpectedly`);
      };
      transport.onerror = (err: Error) => {
        this.logger.error(`MCP transport error: ${err.message}`, err.stack);
      };

      await server.connect(transport);
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (err: unknown) {
        this.logger.error(
          `MCP handleRequest error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal MCP error' });
        }
      }
      return;
    }

    // Invalid or expired session
    this.logger.warn(
      `MCP invalid session request: method=${req.method}, sessionId=${sessionId}, activeSessions=${this.sessions.size}`,
    );
    res.status(400).json({ error: 'Invalid or missing session' });
  }

  async handleSseRequest(req: Request, res: Response, userId: string): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string;
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    session.lastAccess = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  }

  async terminateSession(req: Request, res: Response, userId: string): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string;
    const session = this.sessions.get(sessionId);
    if (session && session.userId === userId) {
      await session.transport.close();
      this.sessions.delete(sessionId);
      this.logger.log(`MCP session terminated: ${sessionId}`);
    }
    res.status(200).json({ ok: true });
  }

  private createServer(userId: string): McpServer {
    const server = new McpServer(
      {
        name: 'botmem',
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

  private cleanupSessions() {
    const maxAge = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccess > maxAge) {
        session.transport.close();
        this.sessions.delete(id);
        this.logger.debug(`MCP session expired: ${id}`);
      }
    }
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
  }): {
    sourceType?: string;
    connectorType?: string;
    contactId?: string;
    from?: string;
    to?: string;
  } {
    return {
      sourceType: params.source_type,
      connectorType: params.connector_type,
      contactId: params.contact_id,
      from: params.date_from,
      to: params.date_to,
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

  // ── Tool registration ─────────────────────────────────────────────

  private registerTools(server: McpServer, userId: string) {
    server.tool(
      'search',
      `Search the user's personal memories using semantic vector search. Returns raw memory records ranked by a weighted score (semantic similarity, recency, importance, trust).

Use this tool when you need to:
- Find specific emails, messages, photos, or events
- Look up what someone said or wrote
- Find memories from a specific time period or source
- Get raw data to answer factual questions

Example queries:
- "meeting with Sarah about the product launch"
- "flights booked in January"
- "photos from the beach trip"
- "messages from Ahmed about the project"

Returns an array of memory objects, each containing: id, text (the memory content), sourceType, connectorType, eventTime, factuality {label, confidence, rationale}, entities (extracted people/places/orgs), metadata (connector-specific fields like email subject, sender, attachments), contacts (associated people with roles), and score weights breakdown.

Tips:
- Use natural language queries — the search is semantic, not keyword-based
- Combine filters to narrow results (e.g. connector_type="gmail" + source_type="email")
- Start with a broad query and refine if needed
- Results are sorted by weighted score (semantic + recency + importance + trust)`,
      {
        query: z
          .string()
          .describe(
            'Natural language search query. Be descriptive — semantic search understands meaning, not just keywords. E.g. "dinner plans with family last week" or "project deadline discussions"',
          ),
        source_type: z
          .string()
          .optional()
          .describe(
            'Filter by source type. One of: "email", "message", "photo", "location". Omit to search all types.',
          ),
        connector_type: z
          .string()
          .optional()
          .describe(
            'Filter by data source connector. One of: "gmail", "slack", "whatsapp", "imessage", "photos". Omit to search all connectors.',
          ),
        contact_id: z
          .string()
          .optional()
          .describe(
            'Filter by a specific contact UUID. Use this when you already know the contact ID from a previous search result.',
          ),
        date_from: z
          .string()
          .optional()
          .describe(
            'Start of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            'End of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
          ),
        text_max_length: z
          .number()
          .optional()
          .default(DEFAULT_TEXT_MAX_LENGTH)
          .describe(
            `Maximum characters per text field in the response excerpt (0-${MAX_TEXT_MAX_LENGTH}). Default: ${DEFAULT_TEXT_MAX_LENGTH}.`,
          ),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Maximum number of results to return (1-100). Default: 20.'),
      },
      async (params) => {
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
          return {
            content: [
              {
                type: 'text' as const,
                text: this.formatMcpResponse(results, params.text_max_length),
              },
            ],
          };
        } catch (err: unknown) {
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
      },
    );

    server.tool(
      'ask',
      `Ask a question about the user's personal memories. Retrieves relevant memories via semantic search, enriches them with contact and entity data, and returns the context needed to answer the question.

Use this tool when:
- The user asks a question that requires reasoning across multiple memories
- You need enriched context (contacts, entities, temporal parsing) rather than raw search results
- The question involves "who", "when", "what happened", or "summarize" patterns

Difference from "search":
- "search" returns raw ranked results — use it for lookup/browsing
- "ask" returns enriched memories grouped by conversation thread, with parsed temporal intent and contact resolution — use it for answering questions

Example queries:
- "What did Ahmed say about the budget?"
- "Who emailed me about the conference last month?"
- "What photos did I take in Dubai?"
- "Summarize my conversations with the design team this week"

Returns: { results: EnrichedMemory[], query: string, parsed?: { temporal, intent, cleanQuery } }
Each EnrichedMemory contains: id, text, sourceType, connectorType, eventTime, eventTimeRelative (human-readable like "3 days ago"), factuality, entities [{type, value}], contacts [{id, displayName, role}], metadata, weights.
The "parsed" field shows how temporal references were interpreted (e.g. "last week" → {from, to} date range).`,
      {
        query: z
          .string()
          .describe(
            'A natural language question about the user\'s memories. Can include temporal references like "last week", "in January", "yesterday". E.g. "What meetings did I have last Friday?" or "What did Sarah say about the marketing plan?"',
          ),
        source_type: z
          .string()
          .optional()
          .describe(
            'Filter by source type. One of: "email", "message", "photo", "location". Omit to search all types.',
          ),
        connector_type: z
          .string()
          .optional()
          .describe(
            'Filter by data source connector. One of: "gmail", "slack", "whatsapp", "imessage", "photos". Omit to search all connectors.',
          ),
        date_from: z
          .string()
          .optional()
          .describe(
            'Start of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
          ),
        date_to: z
          .string()
          .optional()
          .describe(
            'End of event-time range as ISO 8601. Use for precise temporal filters; overrides natural-language dates in the query.',
          ),
        text_max_length: z
          .number()
          .optional()
          .default(DEFAULT_TEXT_MAX_LENGTH)
          .describe(
            `Maximum characters per text field in the response excerpt (0-${MAX_TEXT_MAX_LENGTH}). Default: ${DEFAULT_TEXT_MAX_LENGTH}.`,
          ),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe(
            'Maximum number of context memories to retrieve for answering (1-100). Default: 20. Use higher values for broad questions.',
          ),
      },
      async (params) => {
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
          return {
            content: [
              {
                type: 'text' as const,
                text: this.formatMcpResponse(result, params.text_max_length),
              },
            ],
          };
        } catch (err: unknown) {
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
      },
    );
  }
}
