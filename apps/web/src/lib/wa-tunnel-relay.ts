import { useAuthStore } from '../store/authStore';
import { getAuthData, setAuthData } from './wa-auth-store';

type TunnelStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticated'
  | 'wa-connecting'
  | 'active'
  | 'error';
type StatusHandler = (status: TunnelStatus, detail?: string) => void;

export interface TunnelQrCallbacks {
  onQr: (qrDataUrl: string) => void;
  onAuthSuccess: (data: { accountId?: string; identifier?: string }) => void;
  onAuthError: (error: string) => void;
  onStep?: (step: string) => void;
}

export class WaTunnelRelay {
  private ws: WebSocket | null = null;
  private waWs: WebSocket | null = null;
  private statusHandlers = new Set<StatusHandler>();
  private _status: TunnelStatus = 'disconnected';
  private _sessionId: string | null = null;
  private userId: string;
  private qrCallbacks: TunnelQrCallbacks | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  get status() {
    return this._status;
  }
  get sessionId() {
    return this._sessionId;
  }
  get isActive() {
    return this._status === 'active';
  }

  onStatusChange(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private setStatus(status: TunnelStatus, detail?: string) {
    this._status = status;
    for (const h of this.statusHandlers) h(status, detail);
  }

  /**
   * Connect to the tunnel WS and create a new session.
   * After connection, call startQrAuth() to begin the QR flow.
   */
  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/wa-tunnel`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      let resolved = false;

      this.ws.onopen = () => {
        const token = useAuthStore.getState().accessToken;
        this.ws!.send(JSON.stringify({ event: 'auth', data: { token } }));
      };

      this.ws.onmessage = (event) => {
        // Binary frame from server (Baileys) → forward to WhatsApp
        if (event.data instanceof ArrayBuffer) {
          if (this.waWs?.readyState === WebSocket.OPEN) {
            this.waWs.send(event.data);
          }
          return;
        }

        try {
          const msg = JSON.parse(event.data);

          // Auth response
          if (msg.event === 'auth' && msg.data?.ok) {
            // Request session creation
            this.ws!.send(JSON.stringify({ event: 'create-session' }));
            return;
          }
          if (msg.event === 'auth' && !msg.data?.ok) {
            this.setStatus('error', msg.data?.reason || 'Auth failed');
            if (!resolved) {
              resolved = true;
              reject(new Error(msg.data?.reason || 'Auth failed'));
            }
            return;
          }

          // Session created
          if (msg.event === 'session:created' && msg.data?.sessionId) {
            this._sessionId = msg.data.sessionId;
            this.setStatus('authenticated');
            if (!resolved) {
              resolved = true;
              resolve(msg.data.sessionId);
            }
            return;
          }

          // QR code update (from tunnel QR auth)
          if (msg.event === 'qr:update' && msg.data?.qrData) {
            this.qrCallbacks?.onQr(msg.data.qrData);
            return;
          }

          // Auth status (connecting step, success, etc.)
          if (msg.event === 'auth:status') {
            if (msg.data?.status === 'success') {
              this.qrCallbacks?.onAuthSuccess({
                accountId: msg.data.accountId,
                identifier: msg.data.identifier,
              });
            } else if (msg.data?.step) {
              this.qrCallbacks?.onStep?.(msg.data.step);
            }
            return;
          }

          // Auth error
          if (msg.event === 'auth:error') {
            this.qrCallbacks?.onAuthError(msg.data?.error || 'Authentication failed');
            return;
          }

          // Tunnel attached (for reconnect)
          if (msg.event === 'tunnel:attached') {
            this.setStatus('authenticated');
            return;
          }

          // Control messages from server
          if (msg.type === 'connect') {
            this.openWhatsApp(msg.url);
            return;
          }
          if (msg.type === 'disconnect') {
            this.closeWa();
            return;
          }

          // Auth state proxy requests from server
          if (msg.type === 'auth-state:get') {
            this.handleAuthStateGet(msg.requestId, msg.file);
            return;
          }
          if (msg.type === 'auth-state:set') {
            this.handleAuthStateSet(msg.requestId, msg.file, msg.data);
            return;
          }
        } catch {
          /* ignore */
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.closeWa();
        if (!resolved) {
          resolved = true;
          reject(new Error('Connection closed'));
        }
      };

      this.ws.onerror = () => {
        this.setStatus('error', 'WebSocket connection failed');
        if (!resolved) {
          resolved = true;
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  /**
   * Attach to an existing tunnel session (for reconnect/sync).
   */
  attach(sessionId: string): Promise<void> {
    this._sessionId = sessionId;
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/wa-tunnel`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      let resolved = false;

      this.ws.onopen = () => {
        const token = useAuthStore.getState().accessToken;
        this.ws!.send(
          JSON.stringify({
            event: 'auth',
            data: { token, sessionId },
          }),
        );
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (this.waWs?.readyState === WebSocket.OPEN) {
            this.waWs.send(event.data);
          }
          return;
        }

        try {
          const msg = JSON.parse(event.data);

          if (msg.event === 'auth' && msg.data?.ok) {
            // Auth handled, waiting for tunnel:attached
            return;
          }
          if (msg.event === 'tunnel:attached') {
            this.setStatus('authenticated');
            if (!resolved) {
              resolved = true;
              resolve();
            }
            return;
          }
          if (msg.event === 'tunnel:error') {
            this.setStatus('error', msg.data?.message);
            if (!resolved) {
              resolved = true;
              reject(new Error(msg.data?.message));
            }
            return;
          }

          // Forward same handlers as connect()
          if (msg.type === 'connect') {
            this.openWhatsApp(msg.url);
            return;
          }
          if (msg.type === 'disconnect') {
            this.closeWa();
            return;
          }
          if (msg.type === 'auth-state:get') {
            this.handleAuthStateGet(msg.requestId, msg.file);
            return;
          }
          if (msg.type === 'auth-state:set') {
            this.handleAuthStateSet(msg.requestId, msg.file, msg.data);
            return;
          }
        } catch {
          /* ignore */
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.closeWa();
        if (!resolved) {
          resolved = true;
          reject(new Error('Connection closed'));
        }
      };

      this.ws.onerror = () => {
        this.setStatus('error', 'WebSocket connection failed');
        if (!resolved) {
          resolved = true;
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  /** Request server to start QR auth through the tunnel */
  startQrAuth(callbacks: TunnelQrCallbacks) {
    this.qrCallbacks = callbacks;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'start-qr-auth' }));
    }
  }

  /** Legacy: start with existing sessionId (for backward compat) */
  start(sessionId: string) {
    this.attach(sessionId).catch(() => {});
  }

  private openWhatsApp(url: string) {
    this.closeWa();
    this.setStatus('wa-connecting');

    try {
      this.waWs = new WebSocket(url);
      this.waWs.binaryType = 'arraybuffer';
    } catch (err) {
      this.setStatus('error', `Failed to connect to WhatsApp: ${err}`);
      this.sendControl({ type: 'wa-error', message: String(err) });
      return;
    }

    this.waWs.onopen = () => {
      this.setStatus('active');
      this.sendControl({ type: 'wa-ready' });
    };

    this.waWs.onmessage = (event) => {
      // Frame from WhatsApp → forward to server (Baileys)
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    };

    this.waWs.onclose = (e) => {
      this.waWs = null;
      this.sendControl({ type: 'wa-closed', code: e.code, reason: e.reason });
      if (this._status === 'active') {
        this.setStatus('authenticated'); // WA closed but tunnel still up
      }
    };

    this.waWs.onerror = () => {
      this.sendControl({ type: 'wa-error', message: 'WebSocket error' });
    };
  }

  private closeWa() {
    if (this.waWs) {
      this.waWs.close();
      this.waWs = null;
    }
  }

  private sendControl(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleAuthStateGet(requestId: string, file: string) {
    try {
      const data = await getAuthData(this.userId, file);
      this.sendControl({ type: 'auth-state:get:response', requestId, data });
    } catch {
      this.sendControl({ type: 'auth-state:get:response', requestId, data: null });
    }
  }

  private async handleAuthStateSet(requestId: string, file: string, data: unknown) {
    try {
      await setAuthData(this.userId, file, data);
      this.sendControl({ type: 'auth-state:set:response', requestId, data: { ok: true } });
    } catch {
      this.sendControl({ type: 'auth-state:set:response', requestId, data: { ok: false } });
    }
  }

  stop() {
    this.closeWa();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._sessionId = null;
    this.qrCallbacks = null;
    this.setStatus('disconnected');
  }
}
