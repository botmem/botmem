import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { JobsService } from '../jobs/jobs.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ConfigService } from '../config/config.service';
import { connectorCredentials, users } from '../db/schema';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private pendingConfigs = new Map<
    string,
    { config: Record<string, unknown>; returnTo?: string; userId?: string }
  >();
  private creatingAccounts = new Set<string>();

  constructor(
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private jobsService: JobsService,
    private events: EventsService,
    private dbService: DbService,
    private crypto: CryptoService,
    private analytics: AnalyticsService,
    private config: ConfigService,
  ) {}

  async getSavedCredentials(connectorType: string): Promise<Record<string, unknown> | null> {
    try {
      const [row] = await this.dbService.db
        .select()
        .from(connectorCredentials)
        .where(eq(connectorCredentials.connectorType, connectorType));
      if (!row) return null;
      const decrypted = this.crypto.decrypt(row.credentials) || row.credentials;
      const parsed = JSON.parse(decrypted);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch (err) {
      this.logger.warn(
        'Failed to parse credentials',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async saveCredentials(connectorType: string, config: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    if (connector.manifest.authType !== 'oauth2') return;

    const toSave: Record<string, unknown> = {};
    for (const key of ['clientId', 'clientSecret', 'redirectUri']) {
      if (config[key]) toSave[key] = config[key];
    }
    if (Object.keys(toSave).length === 0) return;

    const now = new Date();
    const encrypted = this.crypto.encrypt(JSON.stringify(toSave))!;
    await this.dbService.db
      .insert(connectorCredentials)
      .values({ connectorType, credentials: encrypted, updatedAt: now })
      .onConflictDoUpdate({
        target: connectorCredentials.connectorType,
        set: { credentials: encrypted, updatedAt: now },
      });
  }

  /** Create account, validate auth, trigger first sync. Returns existing account if already connected. */
  private async createAndSync(
    connectorType: string,
    identifier: string,
    auth: Record<string, unknown>,
    userId?: string,
  ) {
    this.logger.log(`[Auth] createAndSync called: type=${connectorType}`);
    const lockKey = `${connectorType}:${identifier}`;
    if (this.creatingAccounts.has(lockKey)) {
      this.logger.warn(`[Auth] createAndSync: lock already held for ${connectorType}, waiting...`);
      await new Promise((r) => setTimeout(r, 2000));
      const existing = await this.accountsService.findByTypeAndIdentifier(
        connectorType,
        identifier,
        userId,
      );
      if (existing) return existing;
      throw new BadRequestException(`Account ${identifier} is already being created`);
    }
    this.creatingAccounts.add(lockKey);

    try {
      const existing = await this.accountsService.findByTypeAndIdentifier(
        connectorType,
        identifier,
        userId,
      );
      if (existing) {
        await this.accountsService.update(existing.id, {
          authContext: JSON.stringify(auth),
          status: 'connected',
          lastError: null,
        });
        return this.accountsService.getById(existing.id);
      }

      const connector = this.connectors.get(connectorType);
      const valid = await connector.validateAuth(auth);
      if (!valid) {
        throw new BadRequestException('Authentication failed -- check your credentials');
      }

      const account = await this.accountsService.create({
        connectorType,
        identifier,
        authContext: JSON.stringify(auth),
        userId,
      });

      this.analytics.capture('connector_setup', {
        connector: connectorType,
        auth_type: connector.manifest.authType,
      });

      await new Promise((r) => setTimeout(r, 1000));
      await this.jobsService.triggerSync(account.id, connectorType, identifier);

      return account;
    } finally {
      this.creatingAccounts.delete(lockKey);
    }
  }

  async initiate(connectorType: string, config: Record<string, unknown>, userId?: string) {
    const connector = this.connectors.get(connectorType);
    const { returnTo, ...connectorConfig } = config;

    const saved = await this.getSavedCredentials(connectorType);
    let mergedConfig = { ...saved, ...connectorConfig };

    // In Firebase mode, inject server-side OAuth creds for Google connectors
    // Server creds override saved/user creds (spread AFTER mergedConfig)
    if (this.config.authProvider === 'firebase' && connectorType === 'gmail') {
      if (this.config.gmailClientId) {
        mergedConfig = {
          ...mergedConfig,
          clientId: this.config.gmailClientId,
          clientSecret: this.config.gmailClientSecret,
          redirectUri: `${this.config.baseUrl}/api/auth/gmail/callback`,
        };
      }
    }

    let result;
    try {
      result = await connector.initiateAuth(mergedConfig);
    } catch (err: unknown) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to connect -- check your configuration',
      );
    }

    if (result.type === 'complete') {
      const identifier =
        result.auth.identifier ||
        (result.auth as any).raw?.email ||
        (config.identifier as string) ||
        connectorType;
      const account = await this.createAndSync(
        connectorType,
        identifier,
        result.auth as Record<string, unknown>,
        userId,
      );
      return { type: 'complete' as const, account };
    }

    if (result.type === 'qr-code') {
      this.listenForQrCompletion(connector, connectorType, result.wsChannel, userId);

      return {
        type: 'qr-code' as const,
        qrData: result.qrData,
        wsChannel: result.wsChannel,
      };
    }

    this.pendingConfigs.set(connectorType, {
      config: mergedConfig,
      returnTo: returnTo as string | undefined,
      userId,
    });

    await this.saveCredentials(connectorType, mergedConfig);

    return { type: 'redirect' as const, url: result.url };
  }

  private activeQrListeners = new Map<string, boolean>();

  private listenForQrCompletion(
    connector: any,
    connectorType: string,
    wsChannel: string,
    userId?: string,
  ) {
    if (this.activeQrListeners.get(connectorType)) {
      connector.removeAllListeners('connected');
    }
    this.activeQrListeners.set(connectorType, true);

    let handled = false;
    const handler = async (payload: { wsChannel: string; sessionDir: string; auth: any }) => {
      this.logger.log(
        `[Auth] QR 'connected' event received for ${connectorType}, wsChannel=${payload.wsChannel}, handled=${handled}`,
      );
      if (handled) {
        this.logger.warn(`[Auth] Ignoring duplicate 'connected' event for ${connectorType}`);
        return;
      }
      handled = true;
      this.activeQrListeners.delete(connectorType);
      connector.removeListener('connected', handler);

      this.events.emitToChannel(wsChannel, 'auth:status', {
        status: 'connecting',
        step: 'Device linked, connecting...',
      });

      try {
        const auth = payload.auth;
        const jid = auth?.raw?.jid || '';
        const identifier = jid.split('@')[0]?.split(':')[0] || connectorType;
        this.logger.log(`[Auth] Creating account for ${connectorType}`);

        this.events.emitToChannel(wsChannel, 'auth:status', {
          status: 'connecting',
          step: `Connected as ${identifier}, setting up...`,
        });

        const account = await this.createAndSync(
          connectorType,
          identifier,
          auth as Record<string, unknown>,
          userId,
        );
        this.logger.log(`[Auth] Account created: id=${account.id}`);

        this.events.emitToChannel(wsChannel, 'auth:status', {
          status: 'success',
          step: 'Connected! Starting sync...',
          accountId: account.id,
          identifier,
        });
      } catch (err: unknown) {
        this.logger.error(
          `[Auth] QR completion error for ${connectorType}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : String(err),
        );
        this.events.emitToChannel(wsChannel, 'auth:status', {
          status: 'failed',
          step: err instanceof Error ? err.message : 'Failed to complete authentication',
        });
      }
    };

    connector.on('connected', handler);

    const qrHandler = (payload: { wsChannel: string; qrData: string }) => {
      if (payload.wsChannel === wsChannel) {
        this.events.emitToChannel(wsChannel, 'auth:status', {
          status: 'pending',
          qrData: payload.qrData,
        });
      }
    };
    connector.on('qr:update', qrHandler);

    setTimeout(
      () => {
        connector.removeListener('connected', handler);
        connector.removeListener('qr:update', qrHandler);
      },
      5 * 60 * 1000,
    );
  }

  async handleCallback(connectorType: string, params: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    const pending = this.pendingConfigs.get(connectorType);
    const saved = await this.getSavedCredentials(connectorType);
    const mergedParams = { ...saved, ...pending?.config, ...params };
    const auth = await connector.completeAuth(mergedParams);
    this.pendingConfigs.delete(connectorType);

    // Resolve userId: prefer pending (set during initiate), fall back to single-user lookup
    let userId = pending?.userId;
    if (!userId) {
      const allUsers = await this.dbService.db.select({ id: users.id }).from(users).limit(2);
      if (allUsers.length === 1) {
        userId = allUsers[0].id;
        this.logger.warn(`[Auth] OAuth callback had no userId, inferred from single user`);
      } else {
        throw new BadRequestException(
          'OAuth callback failed: could not determine user. Please re-initiate the auth flow while logged in.',
        );
      }
    }

    const identifier =
      auth.identifier || (auth as any).raw?.email || (params.identifier as string) || connectorType;
    const account = await this.createAndSync(
      connectorType,
      identifier,
      auth as Record<string, unknown>,
      userId,
    );

    return { account, returnTo: pending?.returnTo };
  }

  async complete(
    connectorType: string,
    body: { accountId?: string; params: Record<string, unknown> },
    userId?: string,
  ) {
    const connector = this.connectors.get(connectorType);
    const auth = await connector.completeAuth(body.params);

    if (body.accountId) {
      return this.accountsService.update(body.accountId, {
        authContext: JSON.stringify(auth),
        status: 'connected',
      });
    }

    const identifier =
      (body.params.identifier as string) ||
      auth.identifier ||
      (auth as any).raw?.email ||
      connectorType;
    return this.createAndSync(connectorType, identifier, auth as Record<string, unknown>, userId);
  }

  /** Re-run initiateAuth for an existing account — validates the new config then updates the account. */
  async reauth(connectorType: string, accountId: string, config: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    const saved = await this.getSavedCredentials(connectorType);
    const mergedConfig = { ...saved, ...config };

    let result;
    try {
      result = await connector.initiateAuth(mergedConfig);
    } catch (err: unknown) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to connect — check your configuration',
      );
    }

    if (result.type !== 'complete') {
      throw new BadRequestException('Re-auth for this connector type requires a different flow');
    }

    await this.accountsService.update(accountId, {
      authContext: JSON.stringify(result.auth),
      status: 'connected',
      lastError: null,
      identifier: result.auth.identifier || (result.auth as any).raw?.host || accountId,
    });

    return this.accountsService.getById(accountId);
  }
}
