/**
 * Tests for the Outlook connector.
 *
 * Following the testing pattern from the "Building a Connector" guide at
 * docs.botmem.xyz/connectors/building-a-connector.html#_5-testing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutlookConnector } from '../index.js';
import type { ConnectorDataEvent, SyncContext } from '@botmem/connector-sdk';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeSyncContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    accountId: 'test-account',
    auth: {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      identifier: 'test@outlook.com',
      raw: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id',
        redirectUri: 'http://localhost:12412/api/auth/outlook/callback',
      },
    },
    cursor: null,
    jobId: 'test-job',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('OutlookConnector', () => {
  let connector: OutlookConnector;

  beforeEach(() => {
    connector = new OutlookConnector();
    mockFetch.mockReset();
  });

  // ── Manifest ──────────────────────────────────────────────

  describe('manifest', () => {
    it('has correct id and auth type', () => {
      expect(connector.manifest.id).toBe('outlook');
      expect(connector.manifest.authType).toBe('oauth2');
    });

    it('has required fields that docs omit', () => {
      // NOTE (SDK audit): These fields are NOT in the docs but required by types
      expect(connector.manifest.entities).toEqual(['person', 'message', 'file']);
      expect(connector.manifest.pipeline).toEqual({ clean: true, embed: true, enrich: true });
      expect(connector.manifest.trustScore).toBe(0.75);
    });

    it('has configSchema with OAuth fields', () => {
      const props = (connector.manifest.configSchema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('clientId');
      expect(props).toHaveProperty('clientSecret');
      expect(props).toHaveProperty('tenantId');
      expect(props).toHaveProperty('redirectUri');
    });

    it('has empty required array (server may inject creds)', () => {
      const required = (connector.manifest.configSchema as { required: string[] }).required;
      expect(required).toEqual([]);
    });
  });

  // ── Authentication ────────────────────────────────────────

  describe('initiateAuth', () => {
    it('returns redirect to Microsoft OAuth URL', async () => {
      const result = await connector.initiateAuth({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        tenantId: 'test-tenant',
        redirectUri: 'http://localhost:12412/api/auth/outlook/callback',
      });

      expect(result.type).toBe('redirect');
      if (result.type === 'redirect') {
        expect(result.url).toContain('login.microsoftonline.com');
        expect(result.url).toContain('test-tenant');
        expect(result.url).toContain('oauth2/v2.0/authorize');
        expect(result.url).toContain('client_id=test-client-id');
        expect(result.url).toContain('response_type=code');
      }
    });

    it('uses "common" tenant as default', async () => {
      const result = await connector.initiateAuth({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
      });

      if (result.type === 'redirect') {
        expect(result.url).toContain('/common/oauth2/v2.0/authorize');
      }
    });
  });

  describe('completeAuth', () => {
    it('exchanges code for tokens and fetches user profile', async () => {
      // Mock token exchange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      });
      // Mock /me profile
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mail: 'user@outlook.com',
          userPrincipalName: 'user@outlook.com',
        }),
      });

      // Pre-populate config via initiateAuth (as would happen in real flow)
      await connector.initiateAuth({
        clientId: 'cid',
        clientSecret: 'csec',
        tenantId: 'tid',
        redirectUri: 'http://localhost:12412/api/auth/outlook/callback',
      });

      const auth = await connector.completeAuth({ code: 'test-auth-code' });

      expect(auth.accessToken).toBe('new-access-token');
      expect(auth.refreshToken).toBe('new-refresh-token');
      expect(auth.identifier).toBe('user@outlook.com');
      expect(auth.raw).toMatchObject({
        clientId: 'cid',
        clientSecret: 'csec',
        tenantId: 'tid',
      });
    });
  });

  describe('validateAuth', () => {
    it('returns true when accessToken exists', async () => {
      expect(await connector.validateAuth({ accessToken: 'token' })).toBe(true);
    });

    it('returns false when accessToken is missing', async () => {
      expect(await connector.validateAuth({})).toBe(false);
    });
  });

  describe('revokeAuth', () => {
    it('is a no-op (Microsoft has no revoke endpoint)', async () => {
      await expect(connector.revokeAuth({ accessToken: 'token' })).resolves.toBeUndefined();
    });
  });

  // ── Sync ──────────────────────────────────────────────────

  describe('sync', () => {
    it('emits contact and email events', async () => {
      const events: ConnectorDataEvent[] = [];
      connector.on('data', (event: ConnectorDataEvent) => events.push(event));

      // Mock contacts API
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'contact-1',
              displayName: 'John Doe',
              emailAddresses: [{ address: 'john@example.com' }],
              mobilePhone: '+1234567890',
              lastModifiedDateTime: '2026-01-15T10:00:00Z',
            },
          ],
        }),
      });

      // Mock messages API
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'msg-1',
              subject: 'Hello from Outlook',
              from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
              toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.com' } }],
              ccRecipients: [],
              body: { contentType: 'text', content: 'Test email body' },
              receivedDateTime: '2026-03-20T14:30:00Z',
              conversationId: 'conv-1',
              hasAttachments: false,
              categories: [],
              importance: 'normal',
            },
          ],
        }),
      });

      const ctx = makeSyncContext();
      const result = await connector.sync(ctx);

      expect(result.processed).toBe(2); // 1 contact + 1 email
      expect(events).toHaveLength(2);

      // First event should be the contact
      expect(events[0].sourceType).toBe('contact');
      expect(events[0].content.metadata.type).toBe('contact');
      expect(events[0].content.metadata.name).toBe('John Doe');

      // Second event should be the email
      expect(events[1].sourceType).toBe('email');
      expect(events[1].content.metadata.subject).toBe('Hello from Outlook');
      expect(events[1].content.participants).toContain('Alice <alice@example.com>');
    });

    it('handles contacts failure gracefully', async () => {
      const events: ConnectorDataEvent[] = [];
      connector.on('data', (event: ConnectorDataEvent) => events.push(event));

      // Contacts API fails
      mockFetch.mockRejectedValueOnce(new Error('Contacts API down'));

      // Messages API succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'msg-1',
              subject: 'Test',
              from: { emailAddress: { address: 'a@b.com' } },
              toRecipients: [],
              body: { contentType: 'text', content: 'Body' },
              receivedDateTime: '2026-03-20T10:00:00Z',
              hasAttachments: false,
            },
          ],
        }),
      });

      const ctx = makeSyncContext();
      const result = await connector.sync(ctx);

      expect(result.processed).toBe(1); // Only the email
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Contacts sync failed'),
      );
    });

    it('returns cursor for incremental sync', async () => {
      // Must have a data listener or emitData returns false (EventEmitter behavior)
      connector.on('data', () => {});

      // Empty contacts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      // Messages with timestamps
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'msg-1',
              subject: 'Project update meeting notes from last Thursday',
              from: { emailAddress: { name: 'Alice Smith', address: 'alice@company.com' } },
              toRecipients: [{ emailAddress: { name: 'Bob Jones', address: 'bob@company.com' } }],
              ccRecipients: [],
              body: { contentType: 'text', content: 'Here are the meeting notes from our project sync. We discussed the Q2 roadmap and agreed on the next milestones.' },
              receivedDateTime: '2026-03-21T10:00:00Z',
              conversationId: 'conv-1',
              hasAttachments: false,
              categories: [],
              importance: 'normal',
            },
            {
              id: 'msg-2',
              subject: 'Budget review for Q2 planning cycle',
              from: { emailAddress: { name: 'Carol White', address: 'carol@company.com' } },
              toRecipients: [{ emailAddress: { name: 'Dave Brown', address: 'dave@company.com' } }],
              ccRecipients: [],
              body: { contentType: 'text', content: 'Please review the attached budget spreadsheet before our meeting on Friday. The numbers look good overall.' },
              receivedDateTime: '2026-03-20T10:00:00Z',
              conversationId: 'conv-2',
              hasAttachments: false,
              categories: [],
              importance: 'normal',
            },
          ],
        }),
      });

      const ctx = makeSyncContext();
      const result = await connector.sync(ctx);

      expect(result.cursor).toBe('2026-03-21T10:00:00Z');
      expect(result.hasMore).toBe(false);
      expect(result.processed).toBe(2);
    });
  });

  // ── Default Export ────────────────────────────────────────

  describe('default export', () => {
    it('exports a factory function', async () => {
      const mod = await import('../index.js');
      expect(typeof mod.default).toBe('function');
      const instance = mod.default();
      expect(instance).toBeInstanceOf(OutlookConnector);
    });
  });
});
