/**
 * WebSocket tunnel client.
 *
 * Connects to the Botmem server, performs ECDH key exchange,
 * then relays encrypted JSON-RPC requests to the local RPC handler.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encryptJson,
  decryptJson,
} from './crypto.js';
import type { RpcHandler } from './rpc-handler.js';

export interface TunnelOptions {
  serverUrl: string;
  token: string;
  rpcHandler: RpcHandler;
}

export type TunnelStatus = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error';

const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export class TunnelClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private sessionKey: Buffer | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _status: TunnelStatus = 'disconnected';

  constructor(private opts: TunnelOptions) {
    super();
  }

  get status(): TunnelStatus {
    return this._status;
  }

  /** Start the tunnel connection. */
  connect(): void {
    if (this.destroyed) return;
    this.setStatus('connecting');

    const ws = new WebSocket(this.opts.serverUrl, {
      headers: { 'User-Agent': 'botmem-imsg-bridge/0.1' },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.setStatus('authenticating');
      this.performHandshake(ws);
    });

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (this._status === 'authenticating') {
        // Auth response is JSON text
        this.handleAuthResponse(ws, typeof data === 'string' ? data : data.toString('utf-8'));
      } else if (this._status === 'connected') {
        // All post-auth messages are encrypted binary
        if (isBinary || Buffer.isBuffer(data)) {
          this.handleEncryptedMessage(ws, Buffer.isBuffer(data) ? data : Buffer.from(data));
        }
      }
    });

    ws.on('pong', () => {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
    });

    ws.on('close', (code, reason) => {
      this.cleanup();
      if (!this.destroyed) {
        this.emit('log', `Disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.emit('log', `WebSocket error: ${err.message}`);
      // 'close' will fire after this
    });
  }

  /** Gracefully disconnect. */
  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'Bridge shutting down');
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus('disconnected');
  }

  // ── Handshake ───────────────────────────────────────────────────────────

  private performHandshake(ws: WebSocket): void {
    const keyPair = generateKeyPair();
    const publicKeyRaw = exportPublicKey(keyPair.publicKey);

    // Store private key for deriving session key after server responds
    (ws as WebSocket & { _ecdhPrivate?: typeof keyPair.privateKey })._ecdhPrivate =
      keyPair.privateKey;

    ws.send(
      JSON.stringify({
        event: 'auth',
        data: {
          token: this.opts.token,
          publicKey: publicKeyRaw.toString('base64'),
        },
      }),
    );
  }

  private handleAuthResponse(
    ws: WebSocket & { _ecdhPrivate?: import('node:crypto').KeyObject },
    raw: string,
  ): void {
    try {
      const msg = JSON.parse(raw) as {
        event: string;
        data: { ok: boolean; publicKey?: string; reason?: string };
      };

      if (msg.event !== 'auth') return;

      if (!msg.data.ok) {
        const reason = msg.data.reason || 'unknown';
        this.emit('log', `Auth failed: ${reason}`);
        // Permanent auth failures — don't reconnect
        this.destroyed = true;
        this.setStatus('error');
        this.emit('fatal', `Authentication failed: ${reason}. Check your bridge token.`);
        ws.close(4401, 'Auth failed');
        return;
      }

      if (!msg.data.publicKey || !ws._ecdhPrivate) {
        this.emit('log', 'Auth response missing public key');
        this.setStatus('error');
        ws.close(4400, 'Missing public key');
        return;
      }

      // Derive session key
      const serverPubRaw = Buffer.from(msg.data.publicKey, 'base64');
      const serverPub = importPublicKey(serverPubRaw);
      this.sessionKey = deriveSessionKey(ws._ecdhPrivate, serverPub);

      // Clean up private key from ws object
      delete ws._ecdhPrivate;

      this.reconnectAttempt = 0;
      this.setStatus('connected');
      this.startHeartbeat(ws);
      this.emit('log', 'Tunnel connected — encrypted session established');
    } catch (err) {
      this.emit('log', `Auth response parse error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Encrypted message handling ──────────────────────────────────────────

  private handleEncryptedMessage(ws: WebSocket, encrypted: Buffer): void {
    if (!this.sessionKey) return;

    try {
      const request = decryptJson<{
        jsonrpc: '2.0';
        id: number;
        method: string;
        params?: Record<string, unknown>;
      }>(this.sessionKey, encrypted);

      // Dispatch to RPC handler
      const response = this.opts.rpcHandler.handle(request);

      // Encrypt and send response
      const encryptedResponse = encryptJson(this.sessionKey, response);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encryptedResponse);
      }
    } catch (err) {
      this.emit('log', `Failed to handle message: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  private startHeartbeat(ws: WebSocket): void {
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      ws.ping();

      this.heartbeatTimeout = setTimeout(() => {
        this.emit('log', 'Heartbeat timeout — closing connection');
        ws.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Reconnection ────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), MAX_BACKOFF_MS);
    this.reconnectAttempt++;

    this.emit(
      'log',
      `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempt})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private cleanup(): void {
    this.sessionKey = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private setStatus(status: TunnelStatus): void {
    this._status = status;
    this.emit('status', status);
  }
}
