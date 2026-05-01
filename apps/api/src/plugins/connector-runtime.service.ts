import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  AuthContext,
  BaseConnector,
  ConnectorDataEvent,
  ConnectorRealtimeHandle,
} from '@botmem/connector-sdk';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { EventsService } from '../events/events.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { accounts, jobs, rawEvents } from '../db/schema';
import { rawEventSourceHash } from '../db/raw-event-source-hash';

interface RuntimeSession {
  accountId: string;
  connectorType: string;
  sessionKey: string;
  abortController: AbortController;
  handle: ConnectorRealtimeHandle | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function isRealtimeStartTimeout(message: string): boolean {
  return /Realtime start timed out/i.test(message);
}

@Injectable()
export class ConnectorRuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ConnectorRuntimeService.name);
  private readonly sessions = new Map<string, RuntimeSession>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanInProgress = false;

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private events: EventsService,
    private connectors: ConnectorsService,
    @InjectQueue('memory') private memoryQueue: Queue,
  ) {}

  async onApplicationBootstrap() {
    if (process.env.BOTMEM_DISABLE_CONNECTOR_RUNTIME === '1') {
      this.logger.log('Connector runtime disabled by BOTMEM_DISABLE_CONNECTOR_RUNTIME');
      return;
    }

    setTimeout(() => {
      this.ensureRealtimeSessions().catch((err) =>
        this.logger.warn(`Connector runtime initial scan failed: ${err.message}`),
      );
    }, 0);
    this.scanTimer = setInterval(() => {
      this.ensureRealtimeSessions().catch((err) =>
        this.logger.warn(`Connector runtime scan failed: ${err.message}`),
      );
    }, 15_000);
  }

  async onApplicationShutdown() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session)));
  }

  private async ensureRealtimeSessions() {
    if (this.scanInProgress) return;
    this.scanInProgress = true;
    try {
      await this.ensureRealtimeSessionsOnce();
    } finally {
      this.scanInProgress = false;
    }
  }

  private async ensureRealtimeSessionsOnce() {
    const realtimeConnectorTypes = this.connectors
      .list()
      .map((manifest) => manifest.id)
      .filter((id) => this.getRealtimeConnector(id));
    if (!realtimeConnectorTypes.length) return;

    const rows = await this.dbService.db
      .select({
        id: accounts.id,
        userId: accounts.userId,
        connectorType: accounts.connectorType,
        status: accounts.status,
        authContext: accounts.authContext,
      })
      .from(accounts)
      .where(
        and(
          inArray(accounts.connectorType, realtimeConnectorTypes),
          inArray(accounts.status, ['connected', 'degraded', 'reconnect_required']),
          ne(accounts.schedule, 'manual'),
        ),
      );

    for (const account of rows) {
      const connector = this.getRealtimeConnector(account.connectorType);
      const auth = this.getAuthContext(account.authContext);
      if (!connector || !auth) continue;

      const activeJob = await this.dbService.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.accountId, account.id),
            eq(jobs.connectorType, account.connectorType),
            inArray(jobs.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (activeJob.length) {
        const existing = this.sessions.get(account.id);
        if (existing) await this.stopSession(existing);
        continue;
      }

      const sessionKey = JSON.stringify(auth.raw ?? auth);
      const existing = this.sessions.get(account.id);
      if (existing?.sessionKey === sessionKey && existing.handle) continue;
      if (existing && existing.sessionKey !== sessionKey) await this.stopSession(existing);

      await this.startSession(
        connector,
        account.id,
        account.connectorType,
        account.userId ?? undefined,
        auth,
        sessionKey,
      );
    }

    const activeAccountIds = new Set(rows.map((row) => row.id));
    for (const [accountId, session] of this.sessions) {
      if (!activeAccountIds.has(accountId)) await this.stopSession(session);
    }
  }

  private getRealtimeConnector(connectorType: string): BaseConnector | null {
    try {
      const connector = this.connectors.get(connectorType);
      return connector.supportsRealtime() ? connector : null;
    } catch {
      return null;
    }
  }

  private getAuthContext(authContext: string | null): AuthContext | null {
    if (!authContext) return null;
    try {
      const decrypted = this.crypto.decrypt(authContext) ?? authContext;
      return JSON.parse(decrypted) as AuthContext;
    } catch {
      return null;
    }
  }

  private async startSession(
    connector: BaseConnector,
    accountId: string,
    connectorType: string,
    userId: string | undefined,
    auth: AuthContext,
    sessionKey: string,
  ) {
    const session: RuntimeSession = {
      accountId,
      connectorType,
      sessionKey,
      abortController: new AbortController(),
      handle: null,
      reconnectTimer: null,
    };
    this.sessions.set(accountId, session);

    try {
      const handle = await this.startRealtimeWithTimeout(connector, session, {
        accountId,
        auth,
        signal: session.abortController.signal,
        logger: {
          info: (m) => this.logger.log(m),
          warn: (m) => this.logger.warn(m),
          error: (m) => this.logger.error(m),
          debug: (m) => this.logger.debug(m),
        },
        emitData: (event) => this.persistRealtimeEvent(accountId, connectorType, userId, event),
        onConnected: async () => {
          this.logger.log(`Realtime connected: ${connectorType} account ${accountId}`);
          await this.dbService.db
            .update(accounts)
            .set({ status: 'connected', lastError: null, updatedAt: new Date() })
            .where(eq(accounts.id, accountId));
          this.events.emitToChannel('dashboard', 'connector:runtime', {
            connectorType,
            accountId,
            status: 'connected',
          });
        },
        onDisconnect: async ({ reason, reconnectable }) => {
          if (reconnectable) {
            await this.dbService.db
              .update(accounts)
              .set({ status: 'degraded', lastError: reason, updatedAt: new Date() })
              .where(eq(accounts.id, accountId));
            this.events.emitToChannel('dashboard', 'connector:runtime', {
              connectorType,
              accountId,
              status: 'degraded',
            });
            this.scheduleReconnect(session, connector, userId, auth);
            return;
          }
          await this.dbService.db
            .update(accounts)
            .set({ status: 'reconnect_required', lastError: reason, updatedAt: new Date() })
            .where(eq(accounts.id, accountId));
          this.events.emitToChannel('notifications', 'connector:warning', {
            connectorType,
            accountId,
            message: `${connector.manifest.name}: ${reason}. Please reconnect.`,
            action: 'reauth',
          });
          await this.stopSession(session);
        },
      });
      session.handle = handle;
    } catch (err) {
      this.sessions.delete(accountId);
      const message = err instanceof Error ? err.message : String(err);

      if (isRealtimeStartTimeout(message)) {
        await this.dbService.db
          .update(accounts)
          .set({ status: 'degraded', lastError: message, updatedAt: new Date() })
          .where(eq(accounts.id, accountId));
        this.events.emitToChannel('dashboard', 'connector:runtime', {
          connectorType,
          accountId,
          status: 'degraded',
        });
        this.scheduleReconnect(session, connector, userId, auth);
        return;
      }

      await this.dbService.db
        .update(accounts)
        .set({ status: 'reconnect_required', lastError: message, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
      this.events.emitToChannel('notifications', 'connector:warning', {
        connectorType,
        accountId,
        message: `${connector.manifest.name}: ${message}. Please reconnect.`,
        action: 'reauth',
      });
    }
  }

  private async startRealtimeWithTimeout(
    connector: BaseConnector,
    session: RuntimeSession,
    ctx: Parameters<BaseConnector['startRealtime']>[0],
  ): Promise<ConnectorRealtimeHandle> {
    const timeoutMs = Number(process.env.BOTMEM_CONNECTOR_RUNTIME_START_TIMEOUT_MS ?? 60_000);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        connector.startRealtime(ctx),
        new Promise<ConnectorRealtimeHandle>((_, reject) => {
          timeout = setTimeout(() => {
            session.abortController.abort();
            reject(new Error(`Realtime start timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private scheduleReconnect(
    session: RuntimeSession,
    connector: BaseConnector,
    userId: string | undefined,
    auth: AuthContext,
  ) {
    if (session.reconnectTimer) return;
    session.reconnectTimer = setTimeout(async () => {
      session.reconnectTimer = null;
      const shouldReconnect = await this.shouldReconnectSession(session);
      if (!shouldReconnect) {
        await this.stopSession(session);
        return;
      }
      await this.stopSession(session);
      await this.startSession(
        connector,
        session.accountId,
        session.connectorType,
        userId,
        auth,
        session.sessionKey,
      );
    }, 60_000);
  }

  private async shouldReconnectSession(session: RuntimeSession): Promise<boolean> {
    const rows = await this.dbService.db
      .select({
        id: accounts.id,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, session.accountId),
          inArray(accounts.status, ['connected', 'degraded', 'reconnect_required']),
          ne(accounts.schedule, 'manual'),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  private async stopSession(session: RuntimeSession) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    this.sessions.delete(session.accountId);
    session.abortController.abort();
    const handle = session.handle;
    session.handle = null;
    if (handle) await handle.stop().catch(() => undefined);
  }

  private async persistRealtimeEvent(
    accountId: string,
    connectorType: string,
    userId: string | undefined,
    event: ConnectorDataEvent,
  ) {
    const rawEventId = randomUUID();
    const now = new Date();
    const sourceHash = rawEventSourceHash(accountId, connectorType, event.sourceId);
    const insert = async (db: typeof this.dbService.db) =>
      db
        .insert(rawEvents)
        .values({
          id: rawEventId,
          accountId,
          connectorType,
          sourceId: event.sourceId,
          sourceHash,
          sourceType: event.sourceType,
          payload: this.crypto.encrypt(JSON.stringify(event))!,
          timestamp: new Date(event.timestamp),
          jobId: null,
          createdAt: now,
        })
        .onConflictDoNothing({ target: rawEvents.sourceHash })
        .returning({ id: rawEvents.id });

    const inserted = userId
      ? await this.dbService.withUserId(userId, insert)
      : await insert(this.dbService.db);
    if (inserted.length === 0) return;

    await this.dbService.db
      .update(accounts)
      .set({ lastSyncAt: now, updatedAt: now, status: 'connected', lastError: null })
      .where(eq(accounts.id, accountId));

    await this.memoryQueue.add(
      'process',
      { rawEventId },
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
    this.events.emitToChannel('dashboard', 'connector:data', {
      connectorType,
      accountId,
      sourceType: event.sourceType,
    });
  }
}
