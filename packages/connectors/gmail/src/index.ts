import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
  EmbedResult,
  CleanResult,
  PipelineContext,
} from '@botmem/connector-sdk';
import { createOAuth2Client, getAuthUrl, exchangeCode } from './oauth.js';
import { syncGmail } from './sync.js';
import { syncContacts } from './contacts.js';

function parseEmailAddresses(header: string): Array<{ name: string | null; email: string }> {
  if (!header) return [];
  const results: Array<{ name: string | null; email: string }> = [];
  const parts = header.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angleMatch = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
    if (angleMatch) {
      const name = angleMatch[1].replace(/^["']|["']$/g, '').trim();
      results.push({ name: name || null, email: angleMatch[2].toLowerCase() });
    } else if (trimmed.includes('@')) {
      results.push({ name: null, email: trimmed.toLowerCase() });
    }
  }
  return results;
}

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
        redirectUri: {
          type: 'string',
          title: 'Redirect URI',
          default: 'http://localhost:12412/api/auth/gmail/callback',
        },
      },
      required: [],
    },
    entities: ['person', 'message', 'file'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.75,
  };

  private config: Record<string, string> = {};

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    this.config = config as Record<string, string>;
    const redirectUri =
      (config.redirectUri as string) || 'http://localhost:12412/api/auth/gmail/callback';
    const client = createOAuth2Client(
      config.clientId as string,
      config.clientSecret as string,
      redirectUri,
    );
    const url = getAuthUrl(client);
    return { type: 'redirect', url };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    const code = params.code as string;
    const clientId = (params.clientId as string) || this.config.clientId;
    const clientSecret = (params.clientSecret as string) || this.config.clientSecret;
    const redirectUri =
      (params.redirectUri as string) ||
      this.config.redirectUri ||
      'http://localhost:12412/api/auth/gmail/callback';
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
      raw: { clientId, clientSecret, redirectUri, email },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    return !!auth.accessToken;
  }

  async revokeAuth(auth: AuthContext): Promise<void> {
    if (auth.accessToken) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${auth.accessToken}`, {
          method: 'POST',
        });
      } catch {
        // Best effort
      }
    }
  }

  clean(event: ConnectorDataEvent, ctx: PipelineContext): CleanResult {
    // Run base clean first (HTML strip, invisible chars, tracking URLs)
    const base = super.clean(event, ctx) as CleanResult;
    let text = base.text;

    // Strip remaining long encoded URLs (parenthesized markdown-style links)
    text = text.replace(/\(\s*https?:\/\/\S{80,}\s*\)/g, '');
    // Strip standalone long URLs (tracking redirects, email pixels)
    text = text.replace(/https?:\/\/\S{80,}/g, '');
    // Strip email image alt text artifacts like "Logo" on its own line
    text = text.replace(/^\s*Logo\s*$/gm, '');
    // Strip unsubscribe/footer boilerplate
    text = text.replace(/©\s*\d{4}[^\n]*/g, '');
    text = text.replace(/Unsubscribe\s*\(?\s*https?:\/\/\S*\s*\)?\s*/gi, '');
    // Strip repeated whitespace/newlines
    text = text
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return { text };
  }

  embed(event: ConnectorDataEvent, cleanedText: string, _ctx: PipelineContext): EmbedResult {
    const entities: EmbedResult['entities'] = [];
    const metadata = event.content?.metadata || {};

    // Contact events — extract identifiers (compound ID per person)
    if (metadata.type === 'contact') {
      const parts: string[] = [];
      if (metadata.name) parts.push(`name:${metadata.name}`);
      for (const nick of (metadata.nicknames as string[]) || []) {
        if (nick) parts.push(`name:${nick}`);
      }
      for (const email of (metadata.emails as string[]) || []) parts.push(`email:${email}`);
      for (const phone of (metadata.phones as string[]) || [])
        parts.push(`phone:${phone.replace(/\s*\(.*\)/, '').trim()}`);
      if (parts.length) entities.push({ type: 'person', id: parts.join('|'), role: 'participant' });

      // Extract organizations as separate entities
      for (const org of (metadata.organizations as Array<{ name?: string; title?: string }>) ||
        []) {
        if (org.name)
          entities.push({ type: 'organization', id: `name:${org.name}`, role: 'affiliation' });
      }

      return { text: cleanedText, entities, metadata: { isContact: true, ...metadata } };
    }

    // Parse from/to/cc headers
    const fromHeader = (metadata.from as string) || '';
    const toHeader = (metadata.to as string) || '';
    const ccHeader = (metadata.cc as string) || '';

    for (const { name, email } of parseEmailAddresses(fromHeader)) {
      const parts = [`email:${email}`];
      if (name) parts.push(`name:${name}`);
      entities.push({ type: 'person', id: parts.join('|'), role: 'sender' });
    }
    for (const { name, email } of [
      ...parseEmailAddresses(toHeader),
      ...parseEmailAddresses(ccHeader),
    ]) {
      const parts = [`email:${email}`];
      if (name) parts.push(`name:${name}`);
      entities.push({ type: 'person', id: parts.join('|'), role: 'recipient' });
    }

    // Thread linking
    if (metadata.threadId) {
      entities.push({ type: 'message', id: `thread:${metadata.threadId}`, role: 'thread' });
    }

    // Attachments
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
    // Sync contacts first — lightweight and must not be cut off by debug limit
    let contactsProcessed = 0;
    try {
      const contactsResult = await syncContacts(
        ctx,
        (event) => this.emitData(event),
        (progress) => this.emit('progress', progress),
      );
      contactsProcessed = contactsResult.processed;
    } catch (err: unknown) {
      ctx.logger.warn(
        `Contacts sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Sync emails
    const emailResult = await syncGmail(
      ctx,
      (event) => this.emitData(event),
      (progress) =>
        this.emit('progress', {
          processed: contactsProcessed + progress.processed,
          total: contactsProcessed + (progress.total || 0),
        }),
    );

    return {
      cursor: emailResult.cursor,
      hasMore: emailResult.hasMore,
      processed: contactsProcessed + emailResult.processed,
    };
  }
}

export default () => new GmailConnector();
