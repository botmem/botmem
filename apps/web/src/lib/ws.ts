import { wsUrl } from './urls';
import { useAuthStore } from '../store/authStore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageHandler = (msg: { channel: string; event: string; data: any }) => void;

const MAX_BACKOFF = 30_000;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private channelRefs = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private intentionalClose = false;
  private refreshingAuth = false;

  connect(token?: string) {
    const authToken = useAuthStore.getState().accessToken || token;

    // Don't connect without a token -- server will reject with 4401
    if (!authToken) return;

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;

    this.ws = new WebSocket(wsUrl('/events'));
    this.intentionalClose = false;

    this.ws.onopen = () => {
      this.backoff = 1000;
      // Authenticate first, then re-subscribe all channels
      const currentToken = useAuthStore.getState().accessToken;
      if (!currentToken) {
        this.close();
        return;
      }
      this.ws!.send(JSON.stringify({ event: 'auth', data: { token: currentToken } }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // When auth is confirmed, re-subscribe all channels
        if (msg.event === 'auth') {
          if (msg.data?.ok) {
            for (const channel of this.channelRefs.keys()) {
              this.ws!.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
            }
          } else {
            this.handleAuthFailure();
          }
          return;
        }
        for (const handler of this.handlers) handler(msg);
      } catch {
        /* empty */
      }
    };

    this.ws.onclose = (event) => {
      if (this.intentionalClose) return;
      if (event.code === 4401 || /auth|token|unauthor/i.test(event.reason)) {
        this.handleAuthFailure();
        return;
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
      this.connect();
    }, this.backoff);
  }

  private async handleAuthFailure() {
    if (this.refreshingAuth) return;
    this.refreshingAuth = true;
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
    const refreshed = await useAuthStore.getState().refreshSession();
    this.refreshingAuth = false;
    if (refreshed) {
      this.intentionalClose = false;
      this.connect();
    } else {
      this.close();
    }
  }

  subscribe(channel: string, token?: string) {
    const refs = this.channelRefs.get(channel) || 0;
    this.channelRefs.set(channel, refs + 1);
    if (refs === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
    }
    // Auto-connect on first subscribe
    this.connect(token);
  }

  unsubscribe(channel: string) {
    const refs = this.channelRefs.get(channel) || 0;
    if (refs <= 1) {
      this.channelRefs.delete(channel);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'unsubscribe', data: { channel } }));
      }
    } else {
      this.channelRefs.set(channel, refs - 1);
    }
  }

  onMessage(handler: MessageHandler) {
    this.handlers.add(handler);
  }

  offMessage(handler: MessageHandler) {
    this.handlers.delete(handler);
  }

  close() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export const sharedWs = new WsClient();

if (typeof window !== 'undefined') {
  useAuthStore.subscribe((state, prev) => {
    if (prev.accessToken && !state.accessToken) sharedWs.close();
  });
}
