import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GmailConnector } from '../index.js';
import type {
  SyncContext,
  ConnectorDataEvent,
  PipelineContext,
  ProgressEvent,
  EmbedResult,
} from '@botmem/connector-sdk';

type Entity = EmbedResult['entities'][number];

vi.mock('../oauth.js', () => ({
  createOAuth2Client: vi.fn().mockReturnValue({}),
  getAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/auth?client_id=test'),
  exchangeCode: vi.fn().mockResolvedValue({
    access_token: 'at-123',
    refresh_token: 'rt-456',
    expiry_date: Date.now() + 3600000,
  }),
}));

vi.mock('../sync.js', () => ({
  syncGmail: vi
    .fn()
    .mockImplementation(
      async (
        _ctx: SyncContext,
        _emit: (e: ConnectorDataEvent) => void,
        emitProgress: (p: ProgressEvent) => void,
      ) => {
        emitProgress({ processed: 25, total: 100 });
        return { cursor: 'page2', hasMore: true, processed: 25 };
      },
    ),
}));

vi.mock('../contacts.js', () => ({
  syncContacts: vi
    .fn()
    .mockImplementation(
      async (
        _ctx: SyncContext,
        _emit: (e: ConnectorDataEvent) => void,
        emitProgress: (p: ProgressEvent) => void,
      ) => {
        emitProgress({ processed: 5, total: 5 });
        return { processed: 0 };
      },
    ),
}));

describe('GmailConnector', () => {
  let connector: GmailConnector;

  beforeEach(() => {
    connector = new GmailConnector();
    vi.clearAllMocks();
  });

  describe('manifest', () => {
    it('has correct id', () => {
      expect(connector.manifest.id).toBe('gmail');
    });

    it('has correct auth type', () => {
      expect(connector.manifest.authType).toBe('oauth2');
    });

    it('has config schema with no required fields (server injects in Firebase mode)', () => {
      const schema = connector.manifest.configSchema as { required: string[] };
      expect(schema.required).toEqual([]);
    });
  });

  describe('initiateAuth', () => {
    it('returns redirect with auth url', async () => {
      const result = await connector.initiateAuth({
        clientId: 'cid',
        clientSecret: 'cs',
      });
      expect(result.type).toBe('redirect');
      if (result.type === 'redirect') {
        expect(result.url).toContain('google.com');
      }
    });
  });

  describe('completeAuth', () => {
    it('exchanges code for tokens', async () => {
      // First initiate to set config
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });

      const auth = await connector.completeAuth({ code: 'auth-code' });
      expect(auth.accessToken).toBe('at-123');
      expect(auth.refreshToken).toBe('rt-456');
    });
  });

  describe('validateAuth', () => {
    it('returns true when access token present', async () => {
      expect(await connector.validateAuth({ accessToken: 'tok' })).toBe(true);
    });

    it('returns false when no access token', async () => {
      expect(await connector.validateAuth({})).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('does not throw', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });

    it('handles empty access token', async () => {
      await expect(connector.revokeAuth({})).resolves.toBeUndefined();
    });
  });

  describe('sync', () => {
    it('calls syncGmail and emits progress', async () => {
      const progressListener = vi.fn();
      connector.on('progress', progressListener);

      const ctx = {
        accountId: 'acc-1',
        auth: { accessToken: 'tok' },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(25);
      expect(result.hasMore).toBe(true);
      expect(progressListener).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 25, total: 100 }),
      );
    });
  });

  describe('clean', () => {
    it('strips long encoded URLs in parentheses', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: `Check out (  ${'https://example.com/' + 'a'.repeat(100)}  ) for info`,
          metadata: {},
        },
      };
      const result = connector.clean(event, {} as unknown as PipelineContext);
      expect(result.text).not.toContain('https://example.com');
      expect(result.text).toContain('Check out');
    });

    it('strips standalone long URLs', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: `Visit ${'https://tracker.example.com/' + 'x'.repeat(100)} for details`,
          metadata: {},
        },
      };
      const result = connector.clean(event, {} as unknown as PipelineContext);
      expect(result.text).not.toContain('tracker.example.com');
    });

    it('strips copyright and unsubscribe boilerplate', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Content here\n© 2026 Company Inc. All rights reserved.\nUnsubscribe https://example.com/unsub',
          metadata: {},
        },
      };
      const result = connector.clean(event, {} as unknown as PipelineContext);
      expect(result.text).not.toContain('©');
      expect(result.text).not.toContain('Unsubscribe');
    });

    it('collapses excessive whitespace', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Line 1     Line 2', metadata: {} },
      };
      const result = connector.clean(event, {} as unknown as PipelineContext);
      expect(result.text).toBe('Line 1 Line 2');
    });
  });

  describe('embed', () => {
    it('extracts contact entities with emails, phones, nicknames, orgs', () => {
      const event = {
        sourceType: 'contact' as const,
        sourceId: 'c1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Contact: Alice',
          participants: ['Alice'],
          metadata: {
            type: 'contact',
            name: 'Alice',
            nicknames: ['Ali'],
            emails: ['alice@test.com'],
            phones: ['+1234 (mobile)'],
            organizations: [{ name: 'Acme Inc', title: 'CTO' }],
          },
        },
      };
      const result = connector.embed(event, 'Contact: Alice', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toContain('name:Alice');
      expect(result.entities[0].id).toContain('name:Ali');
      expect(result.entities[0].id).toContain('email:alice@test.com');
      expect(result.entities[0].id).toContain('phone:+1234');
      // Organization entity
      const orgEntity = result.entities.find((e: Entity) => e.type === 'organization');
      expect(orgEntity).toBeDefined();
      expect(orgEntity!.id).toBe('name:Acme Inc');
      expect(result.metadata?.isContact).toBe(true);
    });

    it('extracts sender and recipient from email headers', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Subject\n\nBody',
          participants: [],
          metadata: {
            from: 'Alice <alice@test.com>',
            to: 'Bob <bob@test.com>, carol@test.com',
            cc: '"Dave" <dave@test.com>',
            threadId: 'thread-123',
          },
        },
      };
      const result = connector.embed(event, 'Subject\n\nBody', {} as unknown as PipelineContext);

      const sender = result.entities.find((e: Entity) => e.role === 'sender');
      expect(sender).toBeDefined();
      expect(sender!.id).toContain('email:alice@test.com');
      expect(sender!.id).toContain('name:Alice');

      const recipients = result.entities.filter((e: Entity) => e.role === 'recipient');
      expect(recipients.length).toBe(3); // Bob, carol, Dave

      const thread = result.entities.find((e: Entity) => e.type === 'message');
      expect(thread!.id).toBe('thread:thread-123');
    });

    it('extracts file entities from attachments', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'See attached',
          participants: [],
          attachments: [
            {
              uri: 'gmail://attachment/abc',
              mimeType: 'application/pdf',
              filename: 'report.pdf',
            },
          ],
          metadata: {},
        },
      };
      const result = connector.embed(event, 'See attached', {} as unknown as PipelineContext);
      const file = result.entities.find((e: Entity) => e.type === 'file');
      expect(file).toBeDefined();
      expect(file!.id).toBe('file:report.pdf');
    });

    it('handles email address without angle brackets', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Hi',
          participants: [],
          metadata: { from: 'alice@test.com' },
        },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities[0].id).toBe('email:alice@test.com');
      expect(result.entities[0].role).toBe('sender');
    });

    it('handles empty from/to/cc headers', () => {
      const event = {
        sourceType: 'email' as const,
        sourceId: 'e1',
        timestamp: '2026-01-01T00:00:00Z',
        content: { text: 'Hi', participants: [], metadata: {} },
      };
      const result = connector.embed(event, 'Hi', {} as unknown as PipelineContext);
      expect(result.entities).toEqual([]);
    });

    it('handles contact with no identifiers', () => {
      const event = {
        sourceType: 'contact' as const,
        sourceId: 'c1',
        timestamp: '2026-01-01T00:00:00Z',
        content: {
          text: 'Contact: Unknown',
          participants: [],
          metadata: { type: 'contact' },
        },
      };
      const result = connector.embed(event, 'Contact: Unknown', {} as unknown as PipelineContext);
      expect(result.entities).toEqual([]);
    });
  });

  describe('sync (contacts failure)', () => {
    it('continues with email sync when contacts sync fails', async () => {
      const { syncContacts } = await import('../contacts.js');
      vi.mocked(syncContacts).mockRejectedValueOnce(new Error('People API disabled'));

      const ctx = {
        accountId: 'acc-1',
        auth: { accessToken: 'tok' },
        cursor: null,
        jobId: 'j1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: AbortSignal.timeout(5000),
      };

      const result = await connector.sync(ctx);
      expect(result.processed).toBe(25); // only email count
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Contacts sync failed'));
    });
  });

  describe('completeAuth (email fetch)', () => {
    it('fetches email from Gmail profile API', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ emailAddress: 'user@gmail.com' }),
        }),
      );
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      const auth = await connector.completeAuth({ code: 'code' });
      expect(auth.identifier).toBe('user@gmail.com');
      vi.unstubAllGlobals();
    });

    it('handles Gmail profile fetch failure gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      const auth = await connector.completeAuth({ code: 'code' });
      expect(auth.identifier).toBeUndefined();
      vi.unstubAllGlobals();
    });

    it('handles non-ok profile response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      await connector.initiateAuth({ clientId: 'cid', clientSecret: 'cs' });
      const auth = await connector.completeAuth({ code: 'code' });
      expect(auth.identifier).toBeUndefined();
      vi.unstubAllGlobals();
    });
  });

  describe('revokeAuth (error handling)', () => {
    it('handles revoke fetch failure gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
      await expect(connector.revokeAuth({ accessToken: 'tok' })).resolves.toBeUndefined();
      vi.unstubAllGlobals();
    });
  });
});

describe('default export', () => {
  it('exports factory function', async () => {
    const mod = await import('../index.js');
    const factory = mod.default;
    expect(typeof factory).toBe('function');
    const instance = factory();
    expect(instance).toBeInstanceOf(GmailConnector);
  });
});
