import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineContext, EmbedResult } from '@botmem/connector-sdk';
import { SlackConnector } from '../index.js';

type Entity = EmbedResult['entities'][number];

vi.mock('../oauth.js', () => ({
  getSlackAuthUrl: vi.fn().mockReturnValue('https://slack.com/oauth/v2/authorize?client_id=test'),
  exchangeSlackCode: vi.fn().mockResolvedValue({
    ok: true,
    access_token: 'xoxb-test',
    team: { id: 'T123', name: 'test-workspace' },
  }),
}));

vi.mock('../sync.js', () => ({
  syncSlack: vi
    .fn()
    .mockResolvedValue({ cursor: '{"channels":{}}', hasMore: false, processed: 15 }),
}));

describe('SlackConnector', () => {
  let connector: SlackConnector;

  beforeEach(() => {
    connector = new SlackConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('slack');
    });

    it('has correct auth type', () => {
      expect(connector.manifest.authType).toBe('oauth2');
    });

    it('has config fields for token and OAuth', () => {
      const schema = connector.manifest.configSchema as { properties: Record<string, unknown> };
      expect(schema.properties.token).toBeDefined();
      expect(schema.properties.clientId).toBeDefined();
      expect(schema.properties.clientSecret).toBeDefined();
    });
  });

  describe('initiateAuth', () => {
    it('returns redirect with slack auth url for OAuth flow', async () => {
      const result = await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      expect(result.type).toBe('redirect');
      if (result.type === 'redirect') {
        expect(result.url).toContain('slack.com');
      }
    });

    it('returns complete with token and fetches identity', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ ok: true, user: 'testuser', team: 'myteam' }),
        }),
      );
      const result = await connector.initiateAuth({ token: 'xoxp-test-token' });
      expect(result.type).toBe('complete');
      if (result.type === 'complete') {
        expect(result.auth.accessToken).toBe('xoxp-test-token');
        expect(result.auth.identifier).toBe('testuser@myteam');
      }
      vi.unstubAllGlobals();
    });
  });

  describe('completeAuth', () => {
    it('exchanges code and returns auth context with identity', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ ok: true, user: 'testuser', team: 'myteam' }),
        }),
      );
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      const auth = await connector.completeAuth({ code: 'slack-code' });
      expect(auth.accessToken).toBe('xoxb-test');
      expect(auth.raw?.teamId).toBe('T123');
      expect(auth.identifier).toBe('testuser@myteam');
      vi.unstubAllGlobals();
    });
  });

  describe('validateAuth', () => {
    it('calls slack API to validate', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ ok: true }),
        }),
      );
      const result = await connector.validateAuth({ accessToken: 'xoxb-test' });
      expect(result).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns false on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      const result = await connector.validateAuth({ accessToken: 'bad' });
      expect(result).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });

  describe('sync', () => {
    it('calls syncSlack and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { accessToken: 'xoxb-test' },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(15);
      expect(progressListener).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 15, total: 15 }),
      );
    });
  });

  describe('embed', () => {
    it('extracts contact entities from contact-type events', () => {
      const event = {
        sourceType: 'contact' as const,
        sourceId: 'slack-contact:U123',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Slack contact: Alice',
          participants: ['Alice'],
          metadata: {
            type: 'contact',
            name: 'Alice',
            slackId: 'U123',
            emails: ['alice@example.com'],
            phones: ['+1234567890'],
          },
        },
      };
      const result = connector.embed(
        event,
        'Slack contact: Alice',
        {} as unknown as PipelineContext,
      );
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].id).toContain('name:Alice');
      expect(result.entities[0].id).toContain('slack_id:U123');
      expect(result.entities[0].id).toContain('email:alice@example.com');
      expect(result.entities[0].id).toContain('phone:+1234567890');
      expect(result.metadata?.isContact).toBe(true);
    });

    it('handles contact with no emails/phones', () => {
      const event = {
        sourceType: 'contact' as const,
        sourceId: 'slack-contact:U123',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Slack contact: Bob',
          participants: ['Bob'],
          metadata: { type: 'contact', name: 'Bob', slackId: 'U123' },
        },
      };
      const result = connector.embed(event, 'Slack contact: Bob', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toBe('name:Bob|slack_id:U123');
    });

    it('extracts person entities with roles from message events', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: '[general] Hello',
          participants: ['Alice', 'Bob'],
          metadata: {
            channelId: 'C123',
            channelName: 'general',
            participantProfiles: {
              Alice: { name: 'alice', realName: 'Alice', email: 'alice@test.com' },
              Bob: { name: 'bob', realName: 'Bob' },
            },
            participantRoles: { Alice: ['sender'], Bob: ['recipient'] },
          },
        },
      };
      const result = connector.embed(event, '[general] Hello', {} as unknown as PipelineContext);
      const alice = result.entities.find((e: Entity) => e.id.includes('Alice'));
      const bob = result.entities.find((e: Entity) => e.id.includes('Bob'));
      expect(alice?.role).toBe('sender');
      expect(alice?.id).toContain('email:alice@test.com');
      expect(bob?.role).toBe('recipient');
    });

    it('extracts channel entity', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: '[general] Hello',
          participants: [],
          metadata: { channelId: 'C123', channelName: 'general' },
        },
      };
      const result = connector.embed(event, '[general] Hello', {} as unknown as PipelineContext);
      const channel = result.entities.find((e: Entity) => e.type === 'group');
      expect(channel).toBeDefined();
      expect(channel?.id).toContain('slack_channel:C123');
      expect(channel?.id).toContain('name:general');
    });

    it('extracts thread entity when threadTs present', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'thread reply',
          participants: [],
          metadata: { channelId: 'C123', threadTs: '1234.5678' },
        },
      };
      const result = connector.embed(event, 'thread reply', {} as unknown as PipelineContext);
      const thread = result.entities.find((e: Entity) => e.type === 'message');
      expect(thread).toBeDefined();
      expect(thread?.id).toBe('slack_thread:C123:1234.5678');
    });

    it('extracts file entities from attachments', () => {
      const event = {
        sourceType: 'file' as const,
        sourceId: 'C123:1234.5678:f1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'shared: report.pdf',
          participants: [],
          attachments: [{ uri: 'https://files.slack.com/report.pdf', mimeType: 'application/pdf' }],
          metadata: {},
        },
      };
      const result = connector.embed(event, 'shared: report.pdf', {} as unknown as PipelineContext);
      const file = result.entities.find((e: Entity) => e.type === 'file');
      expect(file).toBeDefined();
      expect(file?.id).toContain('file:');
    });

    it('handles mentioned role', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'hey @Charlie',
          participants: ['Charlie'],
          metadata: {
            participantProfiles: { Charlie: { name: 'charlie', realName: 'Charlie' } },
            participantRoles: { Charlie: ['mentioned'] },
          },
        },
      };
      const result = connector.embed(event, 'hey @Charlie', {} as unknown as PipelineContext);
      expect(result.entities[0].role).toBe('mentioned');
    });

    it('defaults to sender role when no explicit role', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'hi',
          participants: ['Dave'],
          metadata: {
            participantProfiles: { Dave: { name: 'dave' } },
            participantRoles: {},
          },
        },
      };
      const result = connector.embed(event, 'hi', {} as unknown as PipelineContext);
      // Default roles array is ['sender']
      expect(result.entities[0].role).toBe('sender');
    });

    it('handles participant with no profile', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'hi',
          participants: ['Unknown'],
          metadata: { participantRoles: { Unknown: ['sender'] } },
        },
      };
      const result = connector.embed(event, 'hi', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toBe('slack_id:Unknown');
    });

    it('uses channel fallback from metadata.channel', () => {
      const event = {
        sourceType: 'message' as const,
        sourceId: 'C123:1234.5678',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'hi',
          participants: [],
          metadata: { channel: 'random' },
        },
      };
      const result = connector.embed(event, 'hi', {} as unknown as PipelineContext);
      const ch = result.entities.find((e: Entity) => e.type === 'group');
      expect(ch?.id).toContain('name:random');
    });
  });

  describe('initiateAuth (token identity fetch failure)', () => {
    it('returns undefined identifier when identity fetch fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ ok: false }),
        }),
      );
      const result = await connector.initiateAuth({ token: 'xoxp-test' });
      if (result.type === 'complete') {
        expect(result.auth.identifier).toBeUndefined();
      }
      vi.unstubAllGlobals();
    });

    it('returns undefined identifier when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      const result = await connector.initiateAuth({ token: 'xoxp-test' });
      if (result.type === 'complete') {
        expect(result.auth.identifier).toBeUndefined();
      }
      vi.unstubAllGlobals();
    });
  });

  describe('revokeAuth (error path)', () => {
    it('does not throw when revoke fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default).toBe('function');
    expect(mod.default()).toBeInstanceOf(SlackConnector);
  });
});
