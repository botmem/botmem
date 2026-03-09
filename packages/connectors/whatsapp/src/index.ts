import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
  EmbedResult,
  PipelineContext,
} from '@botmem/connector-sdk';
import type { makeWASocket } from '@whiskeysockets/baileys';
import { startQrAuth } from './qr-auth.js';
import { syncWhatsApp, setDecryptFailureCallback } from './sync.js';

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
    entities: ['person', 'message'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.8,
  };

  private sessionCounter = 0;
  private warm: WarmSession | null = null;
  private warmStatus: 'warming' | 'qr_ready' | 'error' = 'warming';
  private warmError: string | null = null;

  // Socket from the QR auth flow, kept alive for the first sync to capture history
  private authSockets = new Map<string, ReturnType<typeof makeWASocket>>();

  constructor() {
    super();
    setDecryptFailureCallback((count) => {
      this.emit('decrypt-failure', {
        message: `WhatsApp session keys are stale — ${count} messages failed to decrypt. Please re-authenticate (re-scan QR code) to fix.`,
        count,
      });
    });
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
        console.log(`[WhatsApp] onConnected sessionId=${sessionId} jid=${auth.raw?.jid}`);
        if (this.warm?.sessionId !== sessionId) {
          console.warn(
            `[WhatsApp] onConnected: warm session mismatch (warm=${this.warm?.sessionId}, got=${sessionId}) — ignoring`,
          );
          return;
        }
        const { wsChannel: ch, sessionDir: sd } = this.warm;
        this.warm = null;

        // Buffer events so history isn't lost before sync attaches handlers.
        // creds.update is NOT bufferable (Baileys fires it immediately), so this is safe.
        console.log(`[WhatsApp] Buffering events on auth socket for sessionDir=${sd}`);
        sock.ev.buffer();
        this.authSockets.set(sd, sock);
        // Auto-cleanup after 10 minutes if sync never picks it up
        setTimeout(() => {
          if (this.authSockets.has(sd)) {
            console.warn(`[WhatsApp] Auth socket for ${sd} expired (never picked up by sync)`);
            this.authSockets.delete(sd);
            try {
              sock.ws?.close();
            } catch {
              /* ignore */
            }
          }
        }, 10 * 60_000);

        console.log(`[WhatsApp] Emitting 'connected' event on channel=${ch}`);
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

  async revokeAuth(auth: AuthContext): Promise<void> {
    const sessionDir = auth.raw?.sessionDir as string;
    if (!sessionDir) return;

    // Close any lingering auth socket for this session
    const sock = this.authSockets.get(sessionDir);
    if (sock) {
      this.authSockets.delete(sessionDir);
      try {
        sock.ws?.close();
      } catch {
        /* ignore */
      }
    }

    // Delete session files from disk
    const { rm } = await import('fs/promises');
    try {
      await rm(sessionDir, { recursive: true, force: true });
      console.log(`[WhatsApp] Deleted session directory: ${sessionDir}`);
    } catch (err) {
      console.warn(`[WhatsApp] Failed to delete session ${sessionDir}:`, err);
    }
  }

  embed(event: ConnectorDataEvent, cleanedText: string, _ctx: PipelineContext): EmbedResult {
    const entities: EmbedResult['entities'] = [];
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];

    const senderPhone = metadata.senderPhone as string | undefined;
    const senderName = metadata.senderName as string | undefined;
    // senderLid intentionally unused — LIDs are opaque and unresolvable
    const selfPhone = metadata.selfPhone as string | undefined;
    const fromMe = metadata.fromMe as boolean | undefined;
    const isGroup = metadata.isGroup as boolean | undefined;
    const chatId = metadata.chatId as string | undefined;
    const chatName = metadata.chatName as string | undefined;

    // Group entity — from message events (chatId) or contact events (groupJid in metadata)
    const groupJidRaw = chatId || (metadata.groupJid as string | undefined);
    if (isGroup && groupJidRaw) {
      const groupJid = groupJidRaw.replace(/@.*$/, '');
      const groupParts = [`whatsapp_group_jid:${groupJid}`];
      const groupDisplayName = chatName || (metadata.name as string | undefined);
      if (groupDisplayName) groupParts.push(`name:${groupDisplayName}`);
      entities.push({ type: 'group', id: groupParts.join('|'), role: 'group' });
    }

    // Sender — use phone as primary identifier, skip LIDs (opaque, unresolvable)
    const phone = senderPhone || (participants[0] || '').replace(/@.*$/, '').split(':')[0];
    if (phone && !phone.includes('-')) {
      const senderParts = [`phone:${phone}`];
      if (senderName && senderName !== 'me' && senderName !== 'Me' && senderName !== phone) {
        senderParts.push(`name:${senderName}`);
      }
      entities.push({ type: 'person', id: senderParts.join('|'), role: 'sender' });
    }
    // Skip LID-only senders — they can't be resolved to a real identity

    // DM recipient
    if (!isGroup && selfPhone) {
      const otherPhone = fromMe ? phone : selfPhone;
      if (otherPhone && otherPhone !== phone) {
        entities.push({ type: 'person', id: `phone:${otherPhone}`, role: 'recipient' });
      }
    }

    // Mentions — compound ID per person
    const mentions = (metadata.mentions as Array<{ phone: string; name: string }>) || [];
    for (const m of mentions) {
      if (!m.phone) continue;
      const mentionParts = [`phone:${m.phone}`];
      if (m.name) mentionParts.push(`name:${m.name}`);
      entities.push({ type: 'person', id: mentionParts.join('|'), role: 'mentioned' });
    }

    // Shared contacts from vCards — compound ID per person
    const sharedContacts =
      (metadata.sharedContacts as Array<{ name: string; phones: string[] }>) || [];
    for (const sc of sharedContacts) {
      const scParts: string[] = [];
      if (sc.name) scParts.push(`name:${sc.name}`);
      for (const p of sc.phones) scParts.push(`phone:${p.replace(/^\+/, '')}`);
      if (scParts.length)
        entities.push({ type: 'person', id: scParts.join('|'), role: 'mentioned' });
    }

    // Remaining participants
    const handledPhones = new Set([
      phone,
      selfPhone,
      ...mentions.map((m) => m.phone),
      ...sharedContacts.flatMap((sc) => sc.phones.map((p) => p.replace(/^\+/, ''))),
    ]);
    for (const p of participants) {
      if (!p || p.includes('-')) continue;
      if (handledPhones.has(p)) continue;
      entities.push({ type: 'person', id: `phone:${p}`, role: 'participant' });
    }

    return { text: cleanedText, entities };
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
