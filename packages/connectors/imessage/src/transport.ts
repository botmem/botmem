/**
 * Transport abstraction for the iMessage JSON-RPC client.
 *
 * Two implementations:
 *   - TcpTransport: direct TCP socket (existing local bridge via socat)
 *   - RpcTransport interface: used by WsTunnelTransport (server-side, in apps/api/)
 */

import { Socket } from 'net';

// ── Interface ───────────────────────────────────────────────────────────────

export interface RpcTransport {
  connect(): Promise<void>;
  disconnect(): void;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ── TCP Transport (extracted from original ImsgClient) ──────────────────────

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

const REQUEST_TIMEOUT_MS = 30_000;

export class TcpTransport implements RpcTransport {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private connected = false;

  constructor(
    private host: string,
    private port: number,
  ) {}

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

  disconnect(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Client disconnected'));
      this.pending.delete(id);
    }
    this.buffer = '';
  }

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
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

  // ── Internals ───────────────────────────────────────────────────────────

  private setupListeners(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    socket.on('close', () => {
      this.connected = false;
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Connection closed'));
        this.pending.delete(id);
      }
      this.buffer = '';
    });

    socket.on('error', (err: Error) => {
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
        continue;
      }

      if (msg.id === undefined || msg.id === null) continue;

      const pending = this.pending.get(msg.id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message);
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}
