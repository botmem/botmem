import { Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ConnectorsService } from '../connectors/connectors.service';
import { AccountsService } from '../accounts/accounts.service';
import { JobsService } from '../jobs/jobs.service';
import { EventsService } from '../events/events.service';
import { DbService } from '../db/db.service';
import { connectorCredentials } from '../db/schema';

@Injectable()
export class AuthService {
  private pendingConfigs = new Map<string, { config: Record<string, unknown>; returnTo?: string }>();
  private creatingAccounts = new Set<string>();

  constructor(
    private connectors: ConnectorsService,
    private accountsService: AccountsService,
    private jobsService: JobsService,
    private events: EventsService,
    private dbService: DbService,
  ) {}

  async getSavedCredentials(connectorType: string): Promise<Record<string, unknown> | null> {
    try {
      const row = this.dbService.db
        .select()
        .from(connectorCredentials)
        .where(eq(connectorCredentials.connectorType, connectorType))
        .get();
      if (!row) return null;
      const parsed = JSON.parse(row.credentials);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  private saveCredentials(connectorType: string, config: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    if (connector.manifest.authType !== 'oauth2') return;

    const toSave: Record<string, unknown> = {};
    for (const key of ['clientId', 'clientSecret', 'redirectUri']) {
      if (config[key]) toSave[key] = config[key];
    }
    if (Object.keys(toSave).length === 0) return;

    const now = new Date().toISOString();
    this.dbService.db
      .insert(connectorCredentials)
      .values({ connectorType, credentials: JSON.stringify(toSave), updatedAt: now })
      .onConflictDoUpdate({
        target: connectorCredentials.connectorType,
        set: { credentials: JSON.stringify(toSave), updatedAt: now },
      })
      .run();
  }

  /** Create account, validate auth, trigger first sync. Rolls back on failure. */
  private async createAndSync(connectorType: string, identifier: string, auth: Record<string, unknown>) {
    // Per-connector lock to prevent concurrent createAndSync race conditions
    // (e.g. multiple WebSocket listeners firing on the same 'connected' event)
    const lockKey = `${connectorType}:${identifier}`;
    if (this.creatingAccounts.has(lockKey)) {
      throw new BadRequestException(`Account ${identifier} is already being created`);
    }

    // Prevent duplicate accounts for the same connector + identifier
    const existing = await this.accountsService.findByTypeAndIdentifier(connectorType, identifier);
    if (existing) {
      throw new BadRequestException(`Account ${identifier} is already connected`);
    }

    this.creatingAccounts.add(lockKey);
    try {
      const connector = this.connectors.get(connectorType);
      const valid = await connector.validateAuth(auth);
      if (!valid) {
        throw new BadRequestException('Authentication failed — check your credentials');
      }

      const account = await this.accountsService.create({
        connectorType,
        identifier,
        authContext: JSON.stringify(auth),
      });

      // Trigger first sync automatically
      await this.jobsService.triggerSync(account.id, connectorType, identifier);

      return account;
    } finally {
      this.creatingAccounts.delete(lockKey);
    }
  }

  async initiate(connectorType: string, config: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    const { returnTo, ...connectorConfig } = config;

    const saved = await this.getSavedCredentials(connectorType);
    const mergedConfig = { ...saved, ...connectorConfig };

    let result;
    try {
      result = await connector.initiateAuth(mergedConfig);
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to connect — check your configuration');
    }

    if (result.type === 'complete') {
      const identifier = result.auth.identifier || (result.auth as any).raw?.email || (config.identifier as string) || connectorType;
      const account = await this.createAndSync(connectorType, identifier, result.auth as Record<string, unknown>);
      return { type: 'complete' as const, account };
    }

    if (result.type === 'qr-code') {
      // Listen for the connector's 'connected' event (fires when user scans QR)
      this.listenForQrCompletion(connector, connectorType, result.wsChannel);

      return {
        type: 'qr-code' as const,
        qrData: result.qrData,
        wsChannel: result.wsChannel,
      };
    }

    this.pendingConfigs.set(connectorType, {
      config: mergedConfig,
      returnTo: returnTo as string | undefined,
    });

    this.saveCredentials(connectorType, mergedConfig);

    return { type: 'redirect' as const, url: result.url };
  }

  /** After returning QR to frontend, listen for the connector's 'connected' event */
  private listenForQrCompletion(connector: any, connectorType: string, wsChannel: string) {
    const handler = async (payload: { wsChannel: string; sessionDir: string; auth: any }) => {
      connector.removeListener('connected', handler);

      try {
        const auth = payload.auth;
        const jid = auth?.raw?.jid || '';
        // Use the JID (WhatsApp phone number) as the identifier
        // Strip device suffix (e.g. "971502284498:24@s.whatsapp.net" → "971502284498")
        const identifier = jid.split('@')[0]?.split(':')[0] || connectorType;

        const account = await this.createAndSync(connectorType, identifier, auth as Record<string, unknown>);

        // Broadcast completion to the frontend via WebSocket
        this.events.emitToChannel(wsChannel, 'auth:complete', {
          connectorType,
          accountId: account.id,
          identifier,
        });
      } catch (err: any) {
        // Broadcast error to the frontend
        this.events.emitToChannel(wsChannel, 'auth:error', {
          connectorType,
          error: err.message || 'Failed to complete authentication',
        });
      }
    };

    connector.on('connected', handler);

    // Forward QR refreshes to the frontend
    const qrHandler = (payload: { wsChannel: string; qrData: string }) => {
      if (payload.wsChannel === wsChannel) {
        this.events.emitToChannel(wsChannel, 'qr:update', { qrData: payload.qrData });
      }
    };
    connector.on('qr:update', qrHandler);

    // Clean up listeners after 5 minutes (timeout)
    setTimeout(() => {
      connector.removeListener('connected', handler);
      connector.removeListener('qr:update', qrHandler);
    }, 5 * 60 * 1000);
  }

  async handleCallback(connectorType: string, params: Record<string, unknown>) {
    const connector = this.connectors.get(connectorType);
    const pending = this.pendingConfigs.get(connectorType);
    const mergedParams = { ...pending?.config, ...params };
    const auth = await connector.completeAuth(mergedParams);
    this.pendingConfigs.delete(connectorType);

    const identifier = auth.identifier || (auth as any).raw?.email || (params.identifier as string) || connectorType;
    const account = await this.createAndSync(connectorType, identifier, auth as Record<string, unknown>);

    return { account, returnTo: pending?.returnTo };
  }

  async complete(connectorType: string, body: { accountId?: string; params: Record<string, unknown> }) {
    const connector = this.connectors.get(connectorType);
    const auth = await connector.completeAuth(body.params);

    if (body.accountId) {
      return this.accountsService.update(body.accountId, {
        authContext: JSON.stringify(auth),
        status: 'connected',
      });
    }

    const identifier = (body.params.identifier as string) || auth.identifier || (auth as any).raw?.email || connectorType;
    return this.createAndSync(connectorType, identifier, auth as Record<string, unknown>);
  }
}
