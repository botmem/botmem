import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
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

  constructor() {
    super();
    // Start warming immediately so QR is ready when user opens the modal
    this._warm();
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

    startQrAuth(sessionDir, {
      onQrCode: (qr) => {
        if (this.warm?.sessionId !== sessionId) return;
        this.warm.qrData = qr;
        // Resolve any callers waiting for the QR
        for (const resolve of this.warm.qrWaiters) resolve(qr);
        this.warm.qrWaiters = [];
      },
      onConnected: (auth: AuthContext) => {
        if (this.warm?.sessionId !== sessionId) return;
        const { wsChannel: ch, sessionDir: sd } = this.warm;
        this.warm = null;
        this.emit('connected', { wsChannel: ch, sessionDir: sd, auth });
        // Pre-warm the next session right away
        this._warm();
      },
      onError: (err) => {
        console.error('[WhatsApp] warm session error:', err.message);
        if (this.warm?.sessionId !== sessionId) return;
        const pendingWaiters = this.warm.qrWaiters.splice(0);
        this.warm = null;
        if (pendingWaiters.length > 0) {
          // Someone is waiting for a QR — spin up a new session immediately
          // and transfer their callbacks so they don't timeout
          this._warm();
          const w = this.warm as WarmSession | null; // re-read after _warm() sets it
          if (w) {
            w.qrWaiters.push(...pendingWaiters);
          } else {
            for (const resolve of pendingWaiters) resolve('');
          }
        } else {
          // No active callers — retry warming after a back-off
          setTimeout(() => this._warm(), 15_000);
        }
      },
    }).catch((err) => {
      console.error('[WhatsApp] startQrAuth failed:', err.message);
      if (this.warm?.sessionId === sessionId) {
        for (const resolve of this.warm.qrWaiters) resolve('');
        this.warm = null;
      }
      setTimeout(() => this._warm(), 3000);
    });
  }

  async initiateAuth(_config: Record<string, unknown>): Promise<AuthInitResult> {
    // Ensure a warm session exists
    if (!this.warm) this._warm();

    const session = this.warm!;

    // QR already ready — return instantly
    if (session.qrData) {
      return { type: 'qr-code', qrData: session.qrData, wsChannel: session.wsChannel };
    }

    // Wait for QR to arrive (with timeout)
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
    const result = await syncWhatsApp(ctx, (event) => this.emitData(event));
    this.emit('progress', { processed: result.processed });
    return result;
  }
}

export default () => new WhatsAppConnector();
