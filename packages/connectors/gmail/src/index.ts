import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
import { createOAuth2Client, getAuthUrl, exchangeCode } from './oauth.js';
import { syncGmail } from './sync.js';
import { syncContacts } from './contacts.js';

export class GmailConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'gmail',
    name: 'Google',
    description: 'Import emails, contacts, and attachments from Google',
    color: '#FF6B9D',
    icon: 'mail',
    authType: 'oauth2',
    configSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', title: 'Google Client ID' },
        clientSecret: { type: 'string', title: 'Google Client Secret' },
        redirectUri: { type: 'string', title: 'Redirect URI', default: 'http://localhost:3001/api/auth/gmail/callback' },
      },
      required: ['clientId', 'clientSecret'],
    },
  };

  private config: Record<string, string> = {};

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    this.config = config as Record<string, string>;
    const redirectUri = (config.redirectUri as string) || 'http://localhost:3001/api/auth/gmail/callback';
    const client = createOAuth2Client(config.clientId as string, config.clientSecret as string, redirectUri);
    const url = getAuthUrl(client);
    return { type: 'redirect', url };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const code = params.code as string;
    const clientId = (params.clientId as string) || this.config.clientId;
    const clientSecret = (params.clientSecret as string) || this.config.clientSecret;
    const redirectUri = (params.redirectUri as string) || this.config.redirectUri || 'http://localhost:3001/api/auth/gmail/callback';
    const client = createOAuth2Client(clientId, clientSecret, redirectUri);
    const tokens = await exchangeCode(client, code);

    // Fetch the user's email address via Gmail profile API (works with gmail.readonly scope)
    let email: string | undefined;
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (res.ok) {
        const profile = await res.json();
        email = profile.emailAddress;
      }
    } catch {
      // Best effort
    }

    return {
      accessToken: tokens.access_token || undefined,
      refreshToken: tokens.refresh_token || undefined,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
      identifier: email,
      raw: { clientId, clientSecret, email },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    return !!auth.accessToken;
  }

  async revokeAuth(auth: AuthContext): Promise<void> {
    if (auth.accessToken) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${auth.accessToken}`, { method: 'POST' });
      } catch {
        // Best effort
      }
    }
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    // Sync emails
    const emailResult = await syncGmail(
      ctx,
      (event) => this.emit('data', event),
      (progress) => this.emit('progress', progress),
    );

    // Sync contacts (only on first sync or when no cursor — contacts don't paginate the same way)
    let contactsProcessed = 0;
    try {
      const contactsResult = await syncContacts(
        ctx,
        (event) => this.emit('data', event),
        (progress) => this.emit('progress', {
          processed: emailResult.processed + progress.processed,
          total: (emailResult.processed) + (progress.total || 0),
        }),
      );
      contactsProcessed = contactsResult.processed;
    } catch (err: any) {
      ctx.logger.warn(`Contacts sync failed (non-fatal): ${err.message}`);
    }

    return {
      cursor: emailResult.cursor,
      hasMore: emailResult.hasMore,
      processed: emailResult.processed + contactsProcessed,
    };
  }
}

export default () => new GmailConnector();
