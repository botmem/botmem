type MessageHandler = (msg: { channel: string; event: string; data: any }) => void;

const MAX_BACKOFF = 30_000;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private channelRefs = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private intentionalClose = false;
  private token: string | null = null;

  connect(token?: string) {
    if (token) {
      this.token = token;
    }

    // Don't connect without a token -- server will reject with 4401
    if (!this.token) return;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}/events?token=${encodeURIComponent(this.token)}`);
    this.intentionalClose = false;

    this.ws.onopen = () => {
      this.backoff = 1000;
      // Re-subscribe all channels
      for (const channel of this.channelRefs.keys()) {
        this.ws!.send(JSON.stringify({ event: 'subscribe', data: { channel } }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        for (const handler of this.handlers) handler(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      if (this.intentionalClose) return;
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
