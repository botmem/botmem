import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';
import { getSlackAuthUrl, exchangeSlackCode } from './oauth.js';
import { syncSlack } from './sync.js';

async function fetchSlackIdentity(token: string): Promise<{ user?: string; team?: string }> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.ok) {
      return { user: data.user, team: data.team };
    }
  } catch {
    // Best effort
  }
  return {};
}

export class SlackConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'slack',
    name: 'Slack',
    description: 'Import workspace messages from Slack',
    color: '#A855F7',
    icon: 'message-square',
    authType: 'oauth2',
    configSchema: {
      type: 'object',
      authMethods: [
        {
          id: 'token',
          label: 'User Token',
          fields: ['token'],
        },
        {
          id: 'oauth',
          label: 'OAuth',
          fields: ['clientId', 'clientSecret', 'redirectUri'],
        },
      ],
      properties: {
        token: { type: 'string', title: 'User Token', description: 'xoxp-...' },
        clientId: { type: 'string', title: 'Slack App Client ID' },
        clientSecret: { type: 'string', title: 'Slack App Client Secret' },
        redirectUri: { type: 'string', title: 'Redirect URI', default: 'http://localhost:3001/api/auth/slack/callback' },
      },
      required: [],
    },
  };

  private config: Record<string, string> = {};

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    // Direct token auth — skip OAuth
    const token = config.token as string | undefined;
    if (token) {
      const identity = await fetchSlackIdentity(token);
      const identifier = identity.team
        ? `${identity.user}@${identity.team}`
        : undefined;
      return { type: 'complete', auth: { accessToken: token, identifier, raw: identity } };
    }

    // OAuth flow
    this.config = config as Record<string, string>;
    const redirectUri = (config.redirectUri as string) || 'http://localhost:3001/api/auth/slack/callback';
    const url = getSlackAuthUrl(config.clientId as string, redirectUri);
    return { type: 'redirect', url };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const code = params.code as string;
    const redirectUri = (this.config.redirectUri as string) || 'http://localhost:3001/api/auth/slack/callback';
    const data = await exchangeSlackCode(
      (params.clientId as string) || this.config.clientId,
      (params.clientSecret as string) || this.config.clientSecret,
      code,
      redirectUri,
    );

    // Fetch the actual user identity
    const identity = await fetchSlackIdentity(data.access_token);
    const identifier = identity.team
      ? `${identity.user}@${identity.team}`
      : data.team?.name;

    return {
      accessToken: data.access_token,
      identifier,
      raw: { teamId: data.team?.id, teamName: data.team?.name, ...identity },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      const data = await res.json();
      return data.ok;
    } catch {
      return false;
    }
  }

  async revokeAuth(auth: AuthContext): Promise<void> {
    try {
      await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
    } catch {
      // Best effort
    }
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const result = await syncSlack(ctx, (event) => this.emit('data', event));
    this.emit('progress', { processed: result.processed });
    return result;
  }
}

export default () => new SlackConnector();
