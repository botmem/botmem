import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
  EmbedResult,
  PipelineContext,
} from '@botmem/connector-sdk';
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
        redirectUri: {
          type: 'string',
          title: 'Redirect URI',
          default: 'http://localhost:12412/api/auth/slack/callback',
        },
      },
      required: [],
    },
    entities: ['person', 'channel', 'message', 'file'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.9,
  };

  private config: Record<string, string> = {};

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    // Direct token auth — skip OAuth
    const token = config.token as string | undefined;
    if (token) {
      const identity = await fetchSlackIdentity(token);
      const identifier = identity.team ? `${identity.user}@${identity.team}` : undefined;
      return { type: 'complete', auth: { accessToken: token, identifier, raw: identity } };
    }

    // OAuth flow
    this.config = config as Record<string, string>;
    const redirectUri =
      (config.redirectUri as string) || 'http://localhost:12412/api/auth/slack/callback';
    const url = getSlackAuthUrl(config.clientId as string, redirectUri);
    return { type: 'redirect', url };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const code = params.code as string;
    const redirectUri =
      (this.config.redirectUri as string) || 'http://localhost:12412/api/auth/slack/callback';
    const data = await exchangeSlackCode(
      (params.clientId as string) || this.config.clientId,
      (params.clientSecret as string) || this.config.clientSecret,
      code,
      redirectUri,
    );

    // Fetch the actual user identity
    const identity = await fetchSlackIdentity(data.access_token);
    const identifier = identity.team ? `${identity.user}@${identity.team}` : data.team?.name;

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

  embed(event: ConnectorDataEvent, cleanedText: string, _ctx: PipelineContext): EmbedResult {
    const entities: EmbedResult['entities'] = [];
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];

    // Contact events — compound ID per person
    if (metadata.type === 'contact') {
      const parts: string[] = [];
      if (metadata.name) parts.push(`name:${metadata.name}`);
      if (metadata.slackId) parts.push(`slack_id:${metadata.slackId}`);
      for (const email of (metadata.emails as string[]) || []) parts.push(`email:${email}`);
      for (const phone of (metadata.phones as string[]) || []) parts.push(`phone:${phone}`);
      if (parts.length) entities.push({ type: 'person', id: parts.join('|'), role: 'participant' });
      return { text: cleanedText, entities, metadata: { isContact: true, ...metadata } };
    }

    const profiles = (metadata.participantProfiles || undefined) as
      | Record<string, { name: string; realName?: string; email?: string; phone?: string }>
      | undefined;
    const participantRoles = (metadata.participantRoles || {}) as Record<string, string[]>;

    for (const username of participants) {
      if (!username) continue;
      const profile = profiles?.[username];
      const roles = participantRoles[username] || ['sender'];
      let role = 'participant';
      if (roles.includes('sender')) role = 'sender';
      else if (roles.includes('recipient')) role = 'recipient';
      else if (roles.includes('mentioned')) role = 'mentioned';

      const parts = [`slack_id:${username}`];
      if (profile) {
        if (profile.realName) parts.push(`name:${profile.realName}`);
        if (profile.email) parts.push(`email:${profile.email}`);
        if (profile.phone) parts.push(`phone:${profile.phone}`);
      }
      entities.push({ type: 'person', id: parts.join('|'), role });
    }

    // Channel — compound ID
    if (metadata.channelId || metadata.channelName || metadata.channel) {
      const chParts: string[] = [];
      if (metadata.channelId) chParts.push(`slack_channel:${metadata.channelId}`);
      const chName = metadata.channelName || metadata.channel;
      if (chName) chParts.push(`name:${chName}`);
      entities.push({ type: 'group', id: chParts.join('|'), role: 'group' });
    }

    // Thread
    if (metadata.threadTs) {
      entities.push({
        type: 'message',
        id: `slack_thread:${metadata.channelId || ''}:${metadata.threadTs}`,
        role: 'thread',
      });
    }

    // Files
    for (const att of event.content?.attachments || []) {
      entities.push({
        type: 'file',
        id: `file:${(att as { filename?: string; uri: string }).filename || att.uri}`,
        role: 'attachment',
      });
    }

    return { text: cleanedText, entities };
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const result = await syncSlack(
      ctx,
      (event) => this.emitData(event),
      (processed) => this.emit('progress', { processed, total: processed }),
    );
    this.emit('progress', { processed: result.processed, total: result.processed });
    return result;
  }
}

export default () => new SlackConnector();
