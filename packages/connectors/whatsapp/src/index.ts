import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
import type { makeWASocket } from '@whiskeysockets/baileys';
import { startQrAuth } from './qr-auth.js';
import { syncWhatsApp } from './sync.js';

interface WarmSession {
  sessionId: string;
  wsChannel: string;
  sessionDir: string;
  qrData: string | null;
  qrWaiters: Array<(qr: string) => void>;
}

export class WhatsAppConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Import chat messages from WhatsApp',
    color: '#22C55E',
    icon: 'message-circle',
    authType: 'qr-code',
    configSchema: {
      type: 'object',
      properties: {},
    },
  };

  private sessionCounter = 0;
  private warm: WarmSession | null = null;
  private warmStatus: 'warming' | 'qr_ready' | 'error' = 'warming';
  private warmError: string | null = null;

  // Socket from the QR auth flow, kept alive for the first sync to capture history
  private authSockets = new Map<string, ReturnType<typeof makeWASocket>>();

  constructor() {
    super();
    this._warm();
  }

  /** Pop the socket that was created during QR auth for this session dir */
  popAuthSocket(sessionDir: string): ReturnType<typeof makeWASocket> | undefined {
    const sock = this.authSockets.get(sessionDir);
    if (sock) this.authSockets.delete(sessionDir);
    return sock;
  }

  private _warm(): void {
    const sessionId = `wa-session-${Date.now()}-${++this.sessionCounter}`;
    const sessionDir = `./data/whatsapp/${sessionId}`;
    const wsChannel = `auth:${sessionId}`;

    const session: WarmSession = {
      sessionId,
      wsChannel,
      sessionDir,
      qrData: null,
      qrWaiters: [],
    };
    this.warm = session;
    this.warmStatus = 'warming';
    this.warmError = null;

    startQrAuth(sessionDir, {
      onQrCode: (qr) => {
        if (this.warm?.sessionId !== sessionId) return;
        const isRefresh = this.warm.qrData !== null;
        this.warm.qrData = qr;
        this.warmStatus = 'qr_ready';
        for (const resolve of this.warm.qrWaiters) resolve(qr);
        this.warm.qrWaiters = [];
        if (isRefresh) {
          this.emit('qr:update', { wsChannel, qrData: qr });
        }
      },
      onConnected: (auth: AuthContext, sock) => {
        if (this.warm?.sessionId !== sessionId) return;
        const { wsChannel: ch, sessionDir: sd } = this.warm;
        this.warm = null;

        // Store the socket so the first sync can reuse it for history capture
        this.authSockets.set(sd, sock);
        // Auto-cleanup after 10 minutes if sync never picks it up
        setTimeout(() => {
          if (this.authSockets.has(sd)) {
            this.authSockets.delete(sd);
            try { sock.ws?.close(); } catch { /* ignore */ }
          }
        }, 10 * 60_000);

        this.emit('connected', { wsChannel: ch, sessionDir: sd, auth });
        this._warm();
      },
      onError: (err) => {
        console.error('[WhatsApp] warm session error:', err.message);
        this.warmStatus = 'error';
        this.warmError = err.message;
        if (this.warm?.sessionId !== sessionId) return;
        const pendingWaiters = this.warm.qrWaiters.splice(0);
        this.warm = null;
        if (pendingWaiters.length > 0) {
          this._warm();
          const w = this.warm as WarmSession | null;
          if (w) {
            w.qrWaiters.push(...pendingWaiters);
          } else {
            for (const resolve of pendingWaiters) resolve('');
          }
        } else {
          setTimeout(() => this._warm(), 15_000);
        }
      },
    }).catch((err) => {
      console.error('[WhatsApp] startQrAuth failed:', err.message);
      this.warmStatus = 'error';
      this.warmError = err.message;
      if (this.warm?.sessionId === sessionId) {
        for (const resolve of this.warm.qrWaiters) resolve('');
        this.warm = null;
      }
      setTimeout(() => this._warm(), 3000);
    });
  }

  getStatus(): { ready: boolean; status: string; message?: string } {
    return {
      ready: this.warmStatus === 'qr_ready',
      status: this.warmStatus,
      ...(this.warmError && { message: this.warmError }),
    };
  }

  async initiateAuth(_config: Record<string, unknown>): Promise<AuthInitResult> {
    if (!this.warm) this._warm();

    const session = this.warm!;

    if (session.qrData) {
      return { type: 'qr-code', qrData: session.qrData, wsChannel: session.wsChannel };
    }

    const qrData = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('QR code generation timeout')), 90_000);
      session.qrWaiters.push((qr) => {
        clearTimeout(timer);
        if (qr) resolve(qr);
        else reject(new Error('WhatsApp connection failed'));
      });
    });

    return { type: 'qr-code', qrData, wsChannel: session.wsChannel };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    return {
      raw: {
        sessionDir: params.sessionDir as string,
        jid: params.jid as string,
      },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    return !!auth.raw?.sessionDir;
  }

  async revokeAuth(_auth: AuthContext): Promise<void> {
    // Could delete session files
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const sessionDir = ctx.auth.raw?.sessionDir as string;
    // Pass the auth socket if available (first sync after QR link gets the history dump)
    const authSock = sessionDir ? this.popAuthSocket(sessionDir) : undefined;
    const result = await syncWhatsApp(ctx, (event) => this.emitData(event), authSock);
    this.emit('progress', { processed: result.processed });
    return result;
  }
}

export default () => new WhatsAppConnector();
