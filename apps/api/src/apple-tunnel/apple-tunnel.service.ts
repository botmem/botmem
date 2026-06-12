/**
 * Apple Bridge Tunnel Service.
 *
 * Manages encrypted WebSocket sessions between remote apple-bridge
 * clients and the Botmem API. Handles ECDH key exchange, encrypted
 * JSON-RPC relay, and session lifecycle.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from 'node:crypto';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { ConfigService } from '../config/config.service';
import { LogsService } from '../logs/logs.service';
// accounts schema import removed — using raw SQL to bypass RLS

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRelayRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppleBridgeSources {
  contacts: boolean;
  imessages: boolean;
}

export interface AppleTunnelSession {
  sessionId: string;
  userId: string;
  accountId: string;
  bridgeWs: WebSocket | null;
  sessionKey: Buffer | null;
  connectedAt: number;
  lastSeenAt: number;
  pendingRpc: Map<number, PendingRpc>;
  nextRpcId: number;
  disconnectedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  sources: AppleBridgeSources;
}

// ── Crypto helpers (mirrors packages/apple-bridge/src/crypto.ts) ────────────

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from('botmem-apple-tunnel-v1', 'utf-8');
const HKDF_INFO = Buffer.from('aes-256-gcm-session-key', 'utf-8');
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

function generateECDH(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('x25519');
}

function exportPubKey(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(12));
}

function importPubKey(raw: Buffer): KeyObject {
  const { createPublicKey } = require('node:crypto');
  const der = Buffer.concat([X25519_SPKI_HEADER, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function deriveKey(localPrivate: KeyObject, remotePub: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey: localPrivate, publicKey: remotePub });
  return Buffer.from(hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, 32));
}

function encryptPayload(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

function decryptPayload(key: Buffer, payload: Buffer): string {
  if (payload.length < IV_LENGTH + TAG_LENGTH) throw new Error('Payload too short');
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

// ── Constants ────────────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 3_000;
const GRACE_PERIOD_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
const TOKEN_PREFIX = 'apple_bt_';
const RELAY_REQUEST_CHANNEL = 'apple:tunnel:rpc:request';
const RELAY_RESPONSE_CHANNEL = 'apple:tunnel:rpc:response';
const RELAY_STATUS_METHOD = '__status';

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AppleTunnelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppleTunnelService.name);
  private sessions = new Map<string, AppleTunnelSession>(); // sessionId → session
  private accountSessions = new Map<string, string>(); // accountId → sessionId
  private statusListeners = new Map<string, Set<(connected: boolean) => void>>();
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;
  private pendingRelayRpc = new Map<string, PendingRelayRpc>();

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private logsService: LogsService,
    @Optional() private config?: ConfigService,
  ) {}

  onModuleInit() {
    this.setupRedisRelay();
  }

  onModuleDestroy() {
    for (const session of this.sessions.values()) {
      this.destroySession(session.sessionId);
    }
    for (const [, pending] of this.pendingRelayRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Apple relay shutting down'));
    }
    this.pendingRelayRpc.clear();
    this.redisSub?.disconnect();
    this.redisPub?.disconnect();
  }

  // ── Token Management ────────────────────────────────────────────────────

  /** Generate a bridge token for an account. Returns the raw token. */
  generateBridgeToken(): string {
    return TOKEN_PREFIX + randomBytes(32).toString('hex');
  }

  // ── Bridge Registration ─────────────────────────────────────────────────

  /**
   * Authenticate a bridge connection using its token.
   * Looks up the account, creates a session, performs ECDH key exchange.
   * Returns server's public key (base64) for the bridge to derive the shared key.
   */
  async registerBridge(
    token: string,
    ws: WebSocket,
    clientPubKeyB64: string,
    sourceList?: string,
  ): Promise<{
    sessionId: string;
    serverPubKeyB64: string;
    accountId: string;
    userId: string;
  } | null> {
    // Look up account by bridge token
    const account = await this.findAccountByToken(token);
    if (!account) {
      this.logger.warn('Bridge auth failed: invalid token');
      return null;
    }
    const sources = this.normalizeSources(sourceList);
    const sourceState = await this.updateAccountSources(account.id, sources);
    if (sourceState?.mismatch) {
      const message = this.describeBridgeSourceMismatch(sourceState.persistedSources!, sources);
      this.logger.warn(message);
      await this.setBridgeSourceWarning(account.id, message);
    }

    // ECDH key exchange
    const serverKP = generateECDH();
    const clientPubRaw = Buffer.from(clientPubKeyB64, 'base64');
    const clientPub = importPubKey(clientPubRaw);
    const sessionKey = deriveKey(serverKP.privateKey, clientPub);
    const serverPubRaw = exportPubKey(serverKP.publicKey);

    // Destroy existing session for this account
    const existingSessionId = this.accountSessions.get(account.id);
    if (existingSessionId) {
      this.destroySession(existingSessionId);
    }

    const sessionId = randomUUID();
    const session: AppleTunnelSession = {
      sessionId,
      userId: account.userId!,
      accountId: account.id,
      bridgeWs: ws,
      sessionKey,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      pendingRpc: new Map(),
      nextRpcId: 1,
      disconnectedAt: null,
      graceTimer: null,
      heartbeatTimer: null,
      sources,
    };

    this.sessions.set(sessionId, session);
    this.accountSessions.set(account.id, sessionId);
    this.startHeartbeat(session);

    this.logger.log(`Bridge connected: account=${account.id}, session=${sessionId}`);
    this.emitStatus(account.id, true);

    return {
      sessionId,
      serverPubKeyB64: serverPubRaw.toString('base64'),
      accountId: account.id,
      userId: account.userId!,
    };
  }

  // ── RPC Relay ───────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request to the remote bridge and await the response.
   * Used by AppleTunnelTransport when the connector calls AppleClient methods.
   */
  async sendRpcRequest(
    accountId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConnected(accountId)) {
      return this.sendRelayedRpcRequest(accountId, method, params);
    }
    return this.sendLocalRpcRequest(accountId, method, params);
  }

  async hasConnectedBridge(accountId: string): Promise<boolean> {
    if (this.isConnected(accountId)) return true;
    try {
      return (
        (await this.sendRelayedRpcRequest(
          accountId,
          RELAY_STATUS_METHOD,
          undefined,
          STATUS_TIMEOUT_MS,
        )) === true
      );
    } catch {
      return false;
    }
  }

  async getBridgeStatus(accountId: string): Promise<{
    connected: boolean;
    accountId: string;
    sources: AppleBridgeSources | null;
    lastSeenAt: string | null;
    lastError: string | null;
  }> {
    const sessionId = this.accountSessions.get(accountId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    let connected = this.isConnected(accountId);
    let relayed = false;
    if (!connected) {
      try {
        relayed =
          (await this.sendRelayedRpcRequest(
            accountId,
            RELAY_STATUS_METHOD,
            undefined,
            STATUS_TIMEOUT_MS,
          )) === true;
        connected = relayed;
      } catch {
        relayed = false;
      }
    }
    return {
      connected,
      accountId,
      sources: session?.sources ?? null,
      lastSeenAt: session
        ? new Date(session.lastSeenAt).toISOString()
        : relayed
          ? new Date().toISOString()
          : null,
      lastError: connected ? null : 'Apple bridge unreachable. Start the Botmem Apple bridge.',
    };
  }

  private async sendLocalRpcRequest(
    accountId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = this.accountSessions.get(accountId);
    if (!sessionId) throw new Error('No bridge session for this account');

    const session = this.sessions.get(sessionId);
    if (!session?.bridgeWs || session.bridgeWs.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge is not connected');
    }
    if (!session.sessionKey) {
      throw new Error('Session key not established');
    }

    const id = session.nextRpcId++;
    const request = {
      jsonrpc: '2.0' as const,
      id,
      method,
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingRpc.delete(id);
        reject(new Error(`RPC ${method} (id=${id}) timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);

      session.pendingRpc.set(id, { resolve, reject, timer });

      // Encrypt and send
      const encrypted = encryptPayload(session.sessionKey!, JSON.stringify(request));
      session.bridgeWs!.send(encrypted);
    });
  }

  private async sendRelayedRpcRequest(
    accountId: string,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.redisPub || !this.redisSub) {
      throw new Error('No bridge session for this account');
    }

    const requestId = randomUUID();
    const payload = JSON.stringify({ requestId, accountId, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRelayRpc.delete(requestId);
        reject(new Error(`Bridge RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRelayRpc.set(requestId, { resolve, reject, timer });

      this.redisPub!.publish(RELAY_REQUEST_CHANNEL, payload).catch((err) => {
        clearTimeout(timer);
        this.pendingRelayRpc.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Handle an encrypted message from the bridge (a JSON-RPC response). */
  handleBridgeMessage(sessionId: string, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session?.sessionKey) return;
    session.lastSeenAt = Date.now();

    try {
      const decrypted = decryptPayload(session.sessionKey, data);
      const response = JSON.parse(decrypted) as {
        jsonrpc: '2.0';
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };

      if (response.id === undefined || response.id === null) return;

      const pending = session.pendingRpc.get(response.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      session.pendingRpc.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to handle bridge message: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── Session Lifecycle ───────────────────────────────────────────────────

  /** Called when a bridge WebSocket disconnects. Starts grace period. */
  handleDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.bridgeWs = null;
    session.disconnectedAt = Date.now();
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }

    this.logger.log(
      `Bridge disconnected: session=${sessionId}, grace period ${GRACE_PERIOD_MS / 1000}s`,
    );
    this.emitStatus(session.accountId, false);
    void this.setBridgeDisconnectedWarning(session.accountId);

    // Reject all pending RPCs
    for (const [id, pending] of session.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge disconnected'));
      session.pendingRpc.delete(id);
    }

    // Grace period before full cleanup
    session.graceTimer = setTimeout(() => {
      this.destroySession(sessionId);
    }, GRACE_PERIOD_MS);
  }

  /** Fully destroy a session. */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.graceTimer) clearTimeout(session.graceTimer);
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);

    for (const [, pending] of session.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Session destroyed'));
    }

    try {
      session.bridgeWs?.close();
    } catch {
      /* ignore */
    }

    this.sessions.delete(sessionId);
    if (this.accountSessions.get(session.accountId) === sessionId) {
      this.accountSessions.delete(session.accountId);
    }

    this.logger.log(`Session destroyed: ${sessionId}`);
  }

  // ── Status ──────────────────────────────────────────────────────────────

  /** Check if a bridge is connected for a given account. */
  isConnected(accountId: string): boolean {
    const sessionId = this.accountSessions.get(accountId);
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session?.bridgeWs || session.bridgeWs.readyState !== WebSocket.OPEN) return false;
    if (Date.now() - session.lastSeenAt <= HEARTBEAT_STALE_MS) return true;
    this.handleDisconnect(sessionId);
    return false;
  }

  /** Subscribe to connection status changes for an account. */
  onStatusChange(accountId: string, listener: (connected: boolean) => void): () => void {
    let listeners = this.statusListeners.get(accountId);
    if (!listeners) {
      listeners = new Set();
      this.statusListeners.set(accountId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.statusListeners.delete(accountId);
    };
  }

  getSession(sessionId: string): AppleTunnelSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async findAccountByToken(token: string): Promise<{
    id: string;
    userId: string | null;
    authContext: string | null;
    decryptedAuthContext: string;
  } | null> {
    // Query Apple bridge accounts and check token match
    // (token is stored encrypted in authContext — must decrypt each to compare)
    // Uses db directly (no RLS) since this is system-level auth
    // Bypass RLS — no user context available at bridge auth time
    const rows = await this.dbService.queryRaw<{
      id: string;
      userId: string | null;
      authContext: string | null;
    }>(
      `SELECT id, user_id AS "userId", auth_context AS "authContext" FROM accounts WHERE connector_type IN ('apple', 'imessage')`,
    );

    for (const row of rows) {
      const decrypted = this.crypto.decrypt(row.authContext);
      if (!decrypted) continue;
      try {
        const ctx = JSON.parse(decrypted) as {
          raw?: { bridgeToken?: string };
          bridgeToken?: string;
        };
        const storedToken = ctx.raw?.bridgeToken || ctx.bridgeToken;
        if (storedToken === token) {
          return {
            id: row.id,
            userId: row.userId,
            authContext: row.authContext,
            decryptedAuthContext: decrypted,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private normalizeSources(sourceList: string | undefined): AppleBridgeSources {
    const parts = (sourceList || 'contacts,imessages')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    return {
      contacts: parts.length === 0 || parts.includes('contacts'),
      imessages: parts.length === 0 || parts.includes('imessages') || parts.includes('messages'),
    };
  }

  private async updateAccountSources(
    accountId: string,
    reportedSources: AppleBridgeSources,
  ): Promise<{
    persistedSources: AppleBridgeSources | null;
    mismatch: boolean;
  }> {
    try {
      const client = await this.dbService.connectionPool.connect();
      try {
        await client.query('BEGIN');

        const result = await client.query<
          { auth_context: string | null; raw?: never } & Record<string, never>
        >('SELECT auth_context FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        const row = result.rows[0];
        if (!row?.auth_context) {
          await client.query('COMMIT');
          return { persistedSources: null, mismatch: false };
        }

        const decrypted = this.crypto.decrypt(row.auth_context);
        if (!decrypted) {
          await client.query('COMMIT');
          return { persistedSources: null, mismatch: false };
        }

        const ctx = JSON.parse(decrypted) as {
          raw?: Record<string, unknown>;
        };
        const raw = ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
        const hasPersistedSources = Object.prototype.hasOwnProperty.call(raw, 'selectedSources');
        const persistedSources = this.normalizeSelectedSources(
          hasPersistedSources ? raw.selectedSources : undefined,
        );

        const mismatch =
          hasPersistedSources &&
          (persistedSources.contacts !== reportedSources.contacts ||
            persistedSources.imessages !== reportedSources.imessages);

        if (!hasPersistedSources) {
          const next = {
            ...ctx,
            raw: {
              ...raw,
              selectedSources: reportedSources,
            },
          };
          const encrypted = this.crypto.encrypt(JSON.stringify(next));
          await client.query('UPDATE accounts SET auth_context = $1 WHERE id = $2', [
            encrypted,
            accountId,
          ]);
        }

        await client.query('COMMIT');
        return {
          persistedSources: hasPersistedSources ? persistedSources : null,
          mismatch,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      this.logger.warn(
        `Failed to update Apple bridge sources for ${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { persistedSources: null, mismatch: false };
    }
  }

  private async setBridgeSourceWarning(accountId: string, message: string): Promise<void> {
    const safeMessage = message.slice(0, 400);
    try {
      await this.dbService.queryRaw(
        `UPDATE accounts
         SET status = CASE
           WHEN status IN ('reconnect_required', 'failed', 'error') THEN status
           ELSE 'degraded'
         END,
         last_error = $1
         WHERE id = $2`,
        [safeMessage, accountId],
      );
      this.logsService.add({
        connectorType: 'apple',
        accountId,
        stage: 'bridge',
        level: 'warn',
        message: safeMessage,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist Apple bridge source warning for ${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async setBridgeDisconnectedWarning(accountId: string): Promise<void> {
    const message =
      'Apple bridge not connected. Start the Botmem Apple bridge from connector setup, then retry sync.';
    try {
      await this.dbService.queryRaw(
        `UPDATE accounts
         SET status = CASE
           WHEN status = 'reconnect_required' THEN status
           ELSE 'degraded'
         END,
         last_error = $1
         WHERE id = $2`,
        [message, accountId],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist Apple bridge disconnect for ${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private startHeartbeat(session: AppleTunnelSession): void {
    session.bridgeWs?.on?.('pong', () => {
      session.lastSeenAt = Date.now();
    });
    session.heartbeatTimer = setInterval(() => {
      if (!session.bridgeWs || session.bridgeWs.readyState !== WebSocket.OPEN) return;
      if (Date.now() - session.lastSeenAt > HEARTBEAT_STALE_MS) {
        this.handleDisconnect(session.sessionId);
        return;
      }
      // ponytail: one server-side ping loop; move to per-node metrics if bridge count grows.
      session.bridgeWs.ping?.();
    }, HEARTBEAT_INTERVAL_MS);
    session.heartbeatTimer.unref?.();
  }

  private describeBridgeSourceMismatch(
    persistedSources: AppleBridgeSources,
    reportedSources: AppleBridgeSources,
  ): string {
    return `Apple source selection mismatch: reported [contacts=${
      reportedSources.contacts ? 'on' : 'off'
    }, imessages=${reportedSources.imessages ? 'on' : 'off'}] vs account [contacts=${
      persistedSources.contacts ? 'on' : 'off'
    }, imessages=${persistedSources.imessages ? 'on' : 'off'}]. Using persisted account settings.`;
  }

  private normalizeSelectedSources(raw: unknown): AppleBridgeSources {
    const value =
      raw && typeof raw === 'object'
        ? (raw as Partial<Record<keyof AppleBridgeSources, unknown>>)
        : {};
    return {
      contacts: value.contacts !== false,
      imessages: value.imessages !== false,
    };
  }

  private emitStatus(accountId: string, connected: boolean): void {
    const listeners = this.statusListeners.get(accountId);
    if (listeners) {
      for (const listener of listeners) {
        listener(connected);
      }
    }
  }

  private setupRedisRelay(): void {
    if (!this.config?.redisUrl) return;

    this.redisPub = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.redisSub = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.redisPub.on('error', (err) =>
      this.logger.warn(`Apple relay publisher error: ${err.message}`),
    );
    this.redisSub.on('error', (err) =>
      this.logger.warn(`Apple relay subscriber error: ${err.message}`),
    );

    this.redisSub.on('message', (channel, message) => {
      if (channel === RELAY_REQUEST_CHANNEL) {
        this.handleRelayRequest(message).catch((err) =>
          this.logger.warn(
            `Failed to handle Apple relay request: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      } else if (channel === RELAY_RESPONSE_CHANNEL) {
        this.handleRelayResponse(message);
      }
    });

    this.redisSub
      .subscribe(RELAY_REQUEST_CHANNEL, RELAY_RESPONSE_CHANNEL)
      .catch((err) => this.logger.warn(`Failed to subscribe Apple relay: ${err.message}`));
  }

  private async handleRelayRequest(message: string): Promise<void> {
    if (!this.redisPub) return;

    let request: {
      requestId?: string;
      accountId?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      request = JSON.parse(message);
    } catch {
      return;
    }

    const { requestId, accountId, method, params } = request;
    if (!requestId || !accountId || !method) return;

    // Only the process that owns the bridge WebSocket should answer.
    if (!this.isConnected(accountId)) return;

    try {
      const result =
        method === RELAY_STATUS_METHOD
          ? true
          : await this.sendLocalRpcRequest(accountId, method, params);
      await this.redisPub.publish(
        RELAY_RESPONSE_CHANNEL,
        JSON.stringify({ requestId, ok: true, result }),
      );
    } catch (err) {
      await this.redisPub.publish(
        RELAY_RESPONSE_CHANNEL,
        JSON.stringify({
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private handleRelayResponse(message: string): void {
    let response: {
      requestId?: string;
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    try {
      response = JSON.parse(message);
    } catch {
      return;
    }

    if (!response.requestId) return;
    const pending = this.pendingRelayRpc.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRelayRpc.delete(response.requestId);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error || 'Bridge RPC failed'));
    }
  }
}
