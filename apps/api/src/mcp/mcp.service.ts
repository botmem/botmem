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
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session: POST without session ID (initialization)
    if (req.method === 'POST' && !sessionId) {
      const server = this.createServer(userId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Store session as soon as transport generates the ID (before response is sent)
        // to avoid race conditions with follow-up requests from fast clients
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
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid or expired session
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
    const server = new McpServer({
      name: 'Botmem',
      version: '1.0.0',
      icons: [
        {
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAD2klEQVR4nO3cv2oUURTH8bsaY8CQBEEIlimz5AEiFmkVbJQ8g49gu2Dno6TwFQRt0mu2NK0gyBoSIuaf5xZb7MydccWZ+7vZ8/2A4+0Oc88XxOA4mEwmNwELa2NjY2C/NSKABTd3ACcnJ2E8HtsJt9Ha2lrY3t6206y5Azg8PAz7+/t2wm20u7sbDg4O7DSLAJwgAOcIwDkCcI4AnCMA5wjAuaYAxvdf7IUWBLAgmgL4cu+5PZsRwD/a2Xllz7yOjz+G09PvdmqWNYDXbx+HreGKnfr35uVXe85SzicA8+79Vth58sBO/Xu2+dmes5TzpwHc3FyHy8vfdurHYHAnLC0t24kA7DlLOX8awMXFrzCZfLNTP5aXV8L6+qadCMCes5TzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLlfAIwygVEyvkEYJQLiJTzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLlfAIwygVEyvkEYJQLiJTzCcAoFxAp5xOAUS4gUs4nAKNcQKScTwBGuYBIOZ8AjHIBkXI+ARjlAiLl/GkA8ZuAs7MfdurH3bvLYXX1oZ0IwJ6zlPOnAeRUXACeEYBzq6uP7JnX+fnPcHXV/hkaAThHAM5lC6DUPwNzKfX9XQXA/w9Qlz0A5ffxJfw1UPn+KdkDUP4krIQAlO+fQgA9IYCKEi6AAOoIoCcEUFHCBRBAHQH0hAAqSrgAAqgjgJ4QQEUJF0AAdQTQEwKoKOECCKCOAHpCABUlXAAB1BFATwigooQLIIA6AugJAVSUcAEEUEcAPSGAihIugADqCKAnBFBRwgUQQB0B9IQAKkq4AAKoyx5A/Dfxqu/jSwhA+f4p2QPIqXoBJQSQU/X9U1wFoFTq+2cLoNTv43Mp9f2zBYAyEYBzbgIo9c9gtawBeP8+X/n+TbIGUMJfw5Tf5yvfv4m7AJQ/iVO+fxMC6BgBtFBeAAGkEUDHCKCF8gIIII0AOkYALZQXQABpBNAxAmihvAACSCOAjhFAC+UFEEAaAXSMAFooL4AA0gigYwTQQnkBBJBGAB0jgBbKCyCANALoGAG0UF4AAaQRQMcIoIXyAgggjQA6RgAtlBdAAGnuAojfBKi+z1e+fxN3AeREAAUpIYASuQmg1O/z1dwEgDQCcI4AnCMA5wjAOQJwjgCcIwDn/juAo6OjMBqNAm6n4XAYRon9zR0AFhMBOEcAzhGAcwTg3F8DsF9z+XT+dG9wff3BjlggBOAcAThHAM4RgHME4BwBOEcAzv0Bdf3T+USC1UsAAAAASUVORK5CYII=',
          mimeType: 'image/png',
          sizes: ['128x128'],
        },
      ],
    });

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

  // ── Tool registration ─────────────────────────────────────────────

  private registerTools(server: McpServer, userId: string) {
    server.tool(
      'search',
      'Search your personal memories using semantic search. Returns matching memories ranked by relevance.',
      {
        query: z.string().describe('Search query (natural language)'),
        source_type: z
          .string()
          .optional()
          .describe('Filter by source type: email, message, photo, location'),
        connector_type: z
          .string()
          .optional()
          .describe('Filter by connector: gmail, slack, whatsapp, imessage, photos'),
        contact_id: z.string().optional().describe('Filter by contact ID'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
      },
      async (params) => {
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const results = await this.dbService.withUserId(userId, async () => {
            return this.memoryService.search(
              params.query,
              {
                sourceType: params.source_type,
                connectorType: params.connector_type,
                contactId: params.contact_id,
              },
              params.limit,
              false,
              userId,
            );
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
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
      'Ask a question about your memories. Returns an AI-generated answer grounded in your personal data (emails, messages, photos, etc.).',
      {
        query: z.string().describe('Your question in natural language'),
        source_type: z
          .string()
          .optional()
          .describe('Filter by source type: email, message, photo, location'),
        connector_type: z
          .string()
          .optional()
          .describe('Filter by connector: gmail, slack, whatsapp, imessage, photos'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Max context memories to consider (default 20)'),
      },
      async (params) => {
        try {
          const dekError = await this.checkDek(userId);
          if (dekError) return dekError;

          const result = await this.dbService.withUserId(userId, async () => {
            return this.agentService.ask(params.query, {
              filters: { sourceType: params.source_type, connectorType: params.connector_type },
              limit: params.limit,
              userId,
            });
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
