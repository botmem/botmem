/**
 * Outlook Connector for Botmem.
 *
 * Built following ONLY the published docs at docs.botmem.xyz:
 * - /connectors/building-a-connector.html (guide)
 * - /contributing/connector-sdk.html (SDK reference)
 * - @botmem/connector-sdk package (TypeScript types)
 *
 * Every "NOTE (SDK audit)" comment marks a place where the docs were
 * insufficient, wrong, or missing information.
 */

import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
} from '@botmem/connector-sdk';
import { appendFileSync } from 'node:fs';
import { getOutlookAuthUrl, exchangeOutlookCode, type OutlookOAuthConfig } from './oauth.js';
import { GraphClient } from './graph-client.js';
import { syncOutlookContacts } from './contacts.js';
import { syncOutlookEmails } from './sync.js';

export class OutlookConnector extends BaseConnector {
  /**
   * NOTE (SDK audit): The docs at /contributing/connector-sdk.html show
   * ConnectorManifest with only 7 fields:
   *   id, name, description, color, icon, authType, configSchema
   *
   * But the actual TypeScript type in @botmem/connector-sdk requires MORE:
   *   entities, pipeline, trustScore (and optionally weights)
   *
   * An external developer following the docs would write a manifest with 7 fields,
   * then get TypeScript errors about missing properties. They'd have to read the
   * source types to figure out what's needed. This is a BLOCKER-level doc gap.
   */
  readonly manifest: ConnectorManifest = {
    id: 'outlook',
    name: 'Outlook',
    description: 'Import emails and contacts from Microsoft Outlook',
    color: '#0078D4',
    icon: 'mail',
    authType: 'oauth2',
    configSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          title: 'Application (Client) ID',
          description: 'From Azure AD app registration',
        },
        clientSecret: {
          type: 'string',
          title: 'Client Secret',
          description: 'Secret value from Azure AD Certificates & secrets',
        },
        tenantId: {
          type: 'string',
          title: 'Directory (Tenant) ID',
          description: 'Azure AD tenant ID. Use "common" for multi-tenant apps.',
          default: 'common',
        },
        redirectUri: {
          type: 'string',
          title: 'Redirect URI',
          default: 'http://localhost:12412/api/auth/outlook/callback',
        },
      },
      required: [],
    },
    // These 3 fields are NOT in the docs but required by the TypeScript type:
    entities: ['person', 'message', 'file'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.75,
  };

  /**
   * NOTE (SDK audit): The docs don't mention this `config` instance variable
   * pattern. For OAuth2, we need to store the config from initiateAuth() so
   * completeAuth() can access it (clientId, clientSecret, etc.). The docs only
   * show the api-key pattern where initiateAuth returns immediately.
   *
   * Also: the docs don't explain the auth.raw convention — storing connector-specific
   * config (clientId, clientSecret, tenantId, redirectUri) in AuthContext.raw so that
   * sync() can reconstruct the OAuth client later for token refresh.
   */
  private config: Record<string, string> = {};

  // ── Authentication ────────────────────────────────────────

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    // Store config for completeAuth — docs don't explain this is needed for OAuth2
    this.config = config as Record<string, string>;

    const oauthConfig: OutlookOAuthConfig = {
      clientId: config.clientId as string,
      clientSecret: config.clientSecret as string,
      tenantId: (config.tenantId as string) || 'common',
      redirectUri: (config.redirectUri as string) || 'http://localhost:12412/api/auth/outlook/callback',
    };

    const url = getOutlookAuthUrl(oauthConfig);
    return { type: 'redirect', url };
  }

  /**
   * NOTE (SDK audit): The docs say nothing about what params completeAuth receives
   * for OAuth2. We're assuming params.code exists (the authorization code from the
   * OAuth callback). We're also hoping the original config is available via
   * this.config (stored during initiateAuth). If the system creates a new connector
   * instance between initiateAuth and completeAuth, this.config will be empty and
   * we'll need params to contain the config too. The docs should specify this.
   */
  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const code = params.code as string;
    const clientId = (params.clientId as string) || this.config.clientId;
    const clientSecret = (params.clientSecret as string) || this.config.clientSecret;
    const tenantId = (params.tenantId as string) || this.config.tenantId || 'common';
    const redirectUri =
      (params.redirectUri as string) ||
      this.config.redirectUri ||
      'http://localhost:12412/api/auth/outlook/callback';

    const oauthConfig: OutlookOAuthConfig = { clientId, clientSecret, tenantId, redirectUri };
    const tokens = await exchangeOutlookCode(oauthConfig, code);

    // Fetch user email via /me endpoint
    let email: string | undefined;
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (res.ok) {
        const profile = await res.json();
        email = profile.mail || profile.userPrincipalName;
      }
    } catch {
      // Best effort — email is optional for AuthContext.identifier
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
      identifier: email,
      // Store OAuth config in raw so sync() can reconstruct GraphClient for token refresh
      // NOTE (SDK audit): This auth.raw convention is undocumented
      raw: { clientId, clientSecret, tenantId, redirectUri, email },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    return !!auth.accessToken;
  }

  /**
   * NOTE (SDK audit): Microsoft doesn't have a standard token revocation endpoint.
   * The docs don't provide guidance on what to do when a service doesn't support
   * revocation. We just no-op.
   */
  async revokeAuth(_auth: AuthContext): Promise<void> {
    // Microsoft doesn't have a standard token revocation endpoint.
    // Tokens expire naturally. Deleting the account effectively revokes access.
  }

  // ── Sync ──────────────────────────────────────────────────

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const raw = ctx.auth.raw || {};
    const oauthConfig: OutlookOAuthConfig = {
      clientId: raw.clientId as string,
      clientSecret: raw.clientSecret as string,
      tenantId: (raw.tenantId as string) || 'common',
      redirectUri: raw.redirectUri as string,
    };

    const client = new GraphClient({
      accessToken: ctx.auth.accessToken!,
      refreshToken: ctx.auth.refreshToken,
      oauthConfig,
      signal: ctx.signal,
      onTokenRefresh: (newToken) => {
        // NOTE (SDK audit): SyncContext.auth is readonly-ish. There's no documented
        // way to update the stored access token after a refresh during sync.
        // We update the local reference but the persisted auth context may go stale.
        // The SDK should provide a mechanism like ctx.updateAuth() for this.
        (ctx.auth as { accessToken: string }).accessToken = newToken;
      },
    });

    // Phase 1: Sync contacts first (lightweight)
    let contactsProcessed = 0;
    try {
      ctx.logger.info('Starting contacts sync...');
      const contactsResult = await syncOutlookContacts(
        client,
        (event) => this.emitData(event),
        (progress) => this.emitProgress({ processed: progress.processed }),
        ctx.signal,
      );
      contactsProcessed = contactsResult.processed;
      ctx.logger.info(`Contacts sync complete: ${contactsProcessed} contacts`);
      try { appendFileSync('/tmp/outlook-sync.log', `[${new Date().toISOString()}] Contacts sync OK: ${contactsProcessed}\n`); } catch { /* ignore log write failures */ }
    } catch (err: unknown) {
      ctx.logger.warn(
        `Contacts sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Phase 2: Sync emails
    ctx.logger.info('Starting email sync...');
    let emailResult: { cursor: string | null; hasMore: boolean; processed: number };
    try {
      emailResult = await syncOutlookEmails(
        client,
        ctx.cursor,
        (event) => this.emitData(event),
        (progress) =>
          this.emitProgress({
            processed: contactsProcessed + progress.processed,
            total: contactsProcessed + (progress.total || 0),
          }),
        ctx.signal,
      );
      ctx.logger.info(`Email sync complete: ${emailResult.processed} emails, hasMore: ${emailResult.hasMore}`);
      try { appendFileSync('/tmp/outlook-sync.log', `[${new Date().toISOString()}] Email sync OK: ${emailResult.processed} emails, hasMore=${emailResult.hasMore}, cursor=${emailResult.cursor}\n`); } catch { /* ignore log write failures */ }
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message}\n${(err as Error).stack}` : String(err);
      ctx.logger.error(`Email sync FAILED: ${msg}`);
      console.error(`[OutlookConnector] Email sync FAILED:`, msg);
      // Write to file for debugging since NestJS terminal is hard to access
      try { appendFileSync('/tmp/outlook-sync.log', `[${new Date().toISOString()}] Email sync FAILED: ${msg}\n`); } catch { /* ignore log write failures */ }
      emailResult = { cursor: ctx.cursor, hasMore: false, processed: 0 };
    }

    return {
      cursor: emailResult.cursor,
      hasMore: emailResult.hasMore,
      processed: contactsProcessed + emailResult.processed,
    };
  }
}

/**
 * Default export: factory function that returns a new connector instance.
 *
 * NOTE (SDK audit): The guide's example shows `export default () => new MySourceConnector()`
 * but doesn't explicitly state this factory pattern is REQUIRED. The SDK reference docs
 * don't mention it either. An external dev might just do `export default new OutlookConnector()`
 * (singleton) which could cause issues if the registry expects fresh instances.
 */
export default () => new OutlookConnector();
