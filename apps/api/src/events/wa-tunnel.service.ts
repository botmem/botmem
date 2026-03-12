import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'http';

export interface TunnelSession {
  sessionId: string;
  userId: string;
  browserWs: WebSocket | null;
  waReady: boolean;
  pendingFrames: Buffer[];
  relayWs: WebSocket | null;
  createdAt: number;
}

@Injectable()
export class WaTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(WaTunnelService.name);
  private sessions = new Map<string, TunnelSession>();
  private userSessions = new Map<string, string>(); // userId → sessionId
  private relayWss: WebSocketServer | null = null;
  private relayHttp: HttpServer | null = null;
  private relayPort = 0;

  async onModuleDestroy() {
    for (const session of this.sessions.values()) {
      this.destroySession(session.sessionId);
    }
    if (this.relayWss) this.relayWss.close();
    if (this.relayHttp) this.relayHttp.close();
  }

  private ensureRelayServer(): Promise<void> {
    if (this.relayWss) return Promise.resolve();

    return new Promise((resolve) => {
      this.relayHttp = createServer();
      this.relayWss = new WebSocketServer({ server: this.relayHttp });

      this.relayWss.on('connection', (ws, req) => {
        // Extract sessionId from URL path: /wa-relay/<sessionId>
        const match = req.url?.match(/\/wa-relay\/([a-f0-9-]+)/);
        if (!match) {
          ws.close(4400, 'Invalid relay path');
          return;
        }
        const sessionId = match[1];
        const session = this.sessions.get(sessionId);
        if (!session) {
          ws.close(4404, 'Session not found');
          return;
        }

        this.logger.debug(`Baileys connected to relay for session ${sessionId}`);
        session.relayWs = ws;

        // Tell browser to open the real WhatsApp connection
        if (session.browserWs?.readyState === WebSocket.OPEN) {
          session.browserWs.send(
            JSON.stringify({ type: 'connect', url: 'wss://web.whatsapp.com/ws/chat' }),
          );
        }

        ws.on('message', (data: Buffer, isBinary: boolean) => {
          // Baileys → browser (to forward to WhatsApp)
          if (session.waReady && session.browserWs?.readyState === WebSocket.OPEN) {
            session.browserWs.send(data, { binary: isBinary });
          } else {
            session.pendingFrames.push(Buffer.from(data));
          }
        });

        ws.on('close', () => {
          this.logger.debug(`Baileys relay disconnected for session ${sessionId}`);
          session.relayWs = null;
          if (session.browserWs?.readyState === WebSocket.OPEN) {
            session.browserWs.send(JSON.stringify({ type: 'disconnect' }));
          }
        });

        ws.on('error', () => {});
      });

      // Listen on random port on localhost only
      this.relayHttp.listen(0, '127.0.0.1', () => {
        const addr = this.relayHttp!.address();
        this.relayPort = typeof addr === 'object' && addr ? addr.port : 0;
        this.logger.log(`WA tunnel relay server listening on 127.0.0.1:${this.relayPort}`);
        resolve();
      });
    });
  }

  async createSession(userId: string): Promise<{ sessionId: string; relayUrl: string }> {
    await this.ensureRelayServer();

    // One tunnel per user — destroy existing
    const existing = this.userSessions.get(userId);
    if (existing) this.destroySession(existing);

    const sessionId = randomUUID();
    const session: TunnelSession = {
      sessionId,
      userId,
      browserWs: null,
      waReady: false,
      pendingFrames: [],
      relayWs: null,
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.userSessions.set(userId, sessionId);

    // Auto-cleanup after 10 minutes if unused
    setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (s && !s.browserWs && !s.relayWs) {
        this.destroySession(sessionId);
      }
    }, 10 * 60_000);

    return {
      sessionId,
      relayUrl: `ws://127.0.0.1:${this.relayPort}/wa-relay/${sessionId}`,
    };
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      session.browserWs?.close();
    } catch {
      /* ignore close errors */
    }
    try {
      session.relayWs?.close();
    } catch {
      /* ignore close errors */
    }

    this.sessions.delete(sessionId);
    if (this.userSessions.get(session.userId) === sessionId) {
      this.userSessions.delete(session.userId);
    }
  }

  getSession(sessionId: string): TunnelSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByUser(userId: string): TunnelSession | undefined {
    const sessionId = this.userSessions.get(userId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  getRelayUrl(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return `ws://127.0.0.1:${this.relayPort}/wa-relay/${sessionId}`;
  }

  /** Attach a browser WebSocket to an existing tunnel session */
  attachBrowser(sessionId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.browserWs = ws;
    session.waReady = false;
    session.pendingFrames = [];

    ws.on('close', () => {
      if (session.browserWs === ws) {
        session.browserWs = null;
        session.waReady = false;
        // Close relay side too
        try {
          session.relayWs?.close(1001, 'Browser tunnel closed');
        } catch {
          /* ignore */
        }
      }
    });

    return true;
  }

  /** Handle control message from browser */
  handleBrowserControl(sessionId: string, msg: { type: string; [key: string]: unknown }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'wa-ready':
        session.waReady = true;
        // Flush pending frames
        if (session.pendingFrames.length > 0 && session.browserWs?.readyState === WebSocket.OPEN) {
          for (const frame of session.pendingFrames) {
            session.browserWs.send(frame, { binary: true });
          }
          session.pendingFrames = [];
        }
        break;
      case 'wa-closed':
      case 'wa-error':
        session.waReady = false;
        break;
    }
  }

  /** Forward binary frame from browser to Baileys relay */
  handleBrowserFrame(sessionId: string, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.relayWs?.readyState === WebSocket.OPEN) {
      session.relayWs.send(data, { binary: true });
    }
  }

  /** Handle auth-state request from Baileys (proxied via browser IndexedDB) */
  async handleAuthStateRequest(
    sessionId: string,
    requestId: string,
    operation: 'get' | 'set',
    file: string,
    data?: unknown,
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session?.browserWs || session.browserWs.readyState !== WebSocket.OPEN) {
      throw new Error('Browser not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Auth state ${operation} timeout for ${file}`));
      }, 5000);

      const handler = (raw: Buffer | string) => {
        try {
          const str = typeof raw === 'string' ? raw : raw.toString();
          const msg = JSON.parse(str);
          if (msg.type === `auth-state:${operation}:response` && msg.requestId === requestId) {
            session.browserWs!.removeListener('message', handler);
            clearTimeout(timeout);
            resolve(msg.data);
          }
        } catch {
          /* ignore parse errors */
        }
      };

      session.browserWs!.on('message', handler);
      session.browserWs!.send(
        JSON.stringify({
          type: `auth-state:${operation}`,
          requestId,
          file,
          ...(data !== undefined && { data }),
        }),
      );
    });
  }

  /** Check if a user has an active tunnel with browser connected */
  isActive(userId: string): boolean {
    const session = this.getSessionByUser(userId);
    return !!session?.browserWs && session.browserWs.readyState === WebSocket.OPEN;
  }
}
