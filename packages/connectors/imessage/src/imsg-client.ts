/**
 * TCP JSON-RPC 2.0 client for the imsg RPC bridge.
 *
 * Protocol: newline-delimited JSON over TCP.
 * The imsg tool is wrapped with socat:
 *   socat TCP-LISTEN:19876,reuseaddr,fork EXEC:"imsg rpc"
 */

import { Socket } from 'net';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Chat {
  id: number;
  name: string;
  identifier: string;
  guid?: string;
  service: string;
  last_message_at: string;
  participants?: string[];
  is_group?: boolean;
}

export interface Message {
  id: number;
  chat_id: number;
  guid: string;
  sender: string;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments: any[];
  reactions: any[];
  chat_identifier: string;
  chat_name: string;
  participants: string[];
  is_group: boolean;
  reply_to_guid?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Client ───────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

export class ImsgClient {
  private host: string;
  private port: number;
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private connected = false;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  /** Open TCP connection to the imsg RPC bridge. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      const socket = new Socket();
      this.socket = socket;

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        socket.removeListener('error', onError);
      };

      socket.once('error', onError);

      socket.connect(this.port, this.host, () => {
        cleanup();
        this.connected = true;
        this.setupListeners(socket);
        resolve();
      });
    });
  }

  /** Close the TCP connection and reject any pending requests. */
  disconnect(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Client disconnected'));
      this.pending.delete(id);
    }
    this.buffer = '';
  }

  /** List chats from the iMessage database. */
  async chatsList(limit?: number): Promise<Chat[]> {
    const params: Record<string, unknown> = {};
    if (limit !== undefined) params.limit = limit;
    const result = (await this.call('chats.list', params)) as { chats: Chat[] };
    return result.chats;
  }

  /** Retrieve message history for a chat. */
  async messagesHistory(
    chatId: number,
    opts?: { limit?: number; start?: string; end?: string; attachments?: boolean },
  ): Promise<Message[]> {
    const params: Record<string, unknown> = { chat_id: chatId };
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.start !== undefined) params.start = opts.start;
    if (opts?.end !== undefined) params.end = opts.end;
    if (opts?.attachments !== undefined) params.attachments = opts.attachments;
    const result = (await this.call('messages.history', params)) as { messages: Message[] };
    return result.messages;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private setupListeners(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    socket.on('close', () => {
      this.connected = false;
      // Reject all pending requests on unexpected close
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Connection closed'));
        this.pending.delete(id);
      }
      this.buffer = '';
    });

    socket.on('error', (err: Error) => {
      // Reject all pending requests on socket error
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(err);
        this.pending.delete(id);
      }
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Malformed JSON — skip
        continue;
      }

      // Ignore notifications (no id field)
      if (msg.id === undefined || msg.id === null) continue;

      const pending = this.pending.get(msg.id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message);
        (err as any).code = msg.error.code;
        (err as any).data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      this.socket.write(payload, 'utf-8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}
