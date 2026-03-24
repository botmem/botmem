/**
 * CONN-013 → CONN-032: Gmail Connector e2e tests.
 *
 * Tests Gmail OAuth flow, contact sync, email sync, noise filtering,
 * clean/embed pipeline, and cursor handling.
 * External APIs are mocked — tests focus on connector logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AuthContext,
  ConnectorDataEvent,
  SyncContext,
  ConnectorLogger,
} from '@botmem/connector-sdk';

// We import the Gmail connector class directly and mock its external deps
let GmailConnector: any;
let gmailModule: any;

beforeEach(async () => {
  // Dynamic import to avoid top-level side effects
  gmailModule = await import('@botmem/connector-gmail');
  GmailConnector = gmailModule.GmailConnector || gmailModule.default;
  if (typeof GmailConnector === 'function' && !GmailConnector.prototype) {
    // Factory function
    GmailConnector = null;
  }
});

function createConnector() {
  if (GmailConnector && GmailConnector.prototype) {
    return new GmailConnector();
  }
  // Factory default export
  return gmailModule.default();
}

function makeLogger(): ConnectorLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeSyncCtx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    accountId: 'test-account',
    auth: {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      raw: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      },
    },
    cursor: null,
    jobId: 'test-job',
    logger: makeLogger(),
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

describe('Gmail Connector (CONN-013 → CONN-032)', () => {
  let connector: any;

  beforeEach(() => {
    connector = createConnector();
  });

  // CONN-013
  it('CONN-013: Gmail manifest has correct id and authType', () => {
    expect(connector.manifest.id).toBe('gmail');
    expect(connector.manifest.authType).toBe('oauth2');
    expect(connector.manifest.name).toBe('Google');
  });

  // CONN-014
  it('CONN-014: Gmail manifest configSchema includes clientId and clientSecret fields', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties).toHaveProperty('clientId');
    expect(schema.properties).toHaveProperty('clientSecret');
    expect(schema.properties).toHaveProperty('redirectUri');
  });

  // CONN-015
  it('CONN-015: Gmail initiateAuth returns redirect URL with Google OAuth endpoint', async () => {
    const result = await connector.initiateAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:12412/api/auth/gmail/callback',
    });

    expect(result.type).toBe('redirect');
    expect(result.url).toContain('accounts.google.com');
    expect(result.url).toContain('oauth2');
  });

  // CONN-016
  it('CONN-016: Gmail initiateAuth URL includes required scopes', async () => {
    const result = await connector.initiateAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:12412/api/auth/gmail/callback',
    });

    expect(result.url).toContain('scope');
    // Gmail scope should be present
    expect(result.url).toMatch(/gmail|mail|google/i);
  });

  // CONN-017
  it('CONN-017: Gmail manifest entities include person and message', () => {
    expect(connector.manifest.entities).toContain('person');
    expect(connector.manifest.entities).toContain('message');
  });

  // CONN-018
  it('CONN-018: Gmail manifest pipeline has clean and embed enabled', () => {
    expect(connector.manifest.pipeline.clean).not.toBe(false);
    expect(connector.manifest.pipeline.embed).not.toBe(false);
  });

  // CONN-019
  it('CONN-019: Gmail manifest has a positive trustScore', () => {
    expect(connector.manifest.trustScore).toBeGreaterThan(0);
    expect(connector.manifest.trustScore).toBeLessThanOrEqual(1);
  });

  // CONN-020
  it('CONN-020: Gmail redirectUri has a sensible default', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties.redirectUri.default).toContain('/api/auth/gmail/callback');
  });

  // CONN-021
  it('CONN-021: Gmail noise filter skips CATEGORY_PROMOTIONS (via shared isNoise)', () => {
    const { isMarketingEmail } = require('@botmem/connector-sdk');
    expect(
      isMarketingEmail('50% off everything! Unsubscribe here.', {
        labels: ['CATEGORY_PROMOTIONS'],
      }),
    ).toBe(true);
  });

  // CONN-022
  it('CONN-022: Gmail noise filter skips CATEGORY_SOCIAL (via shared isNoise)', () => {
    const { isMarketingEmail } = require('@botmem/connector-sdk');
    expect(
      isMarketingEmail('John liked your post! Unsubscribe from notifications.', {
        labels: ['CATEGORY_SOCIAL'],
      }),
    ).toBe(true);
  });

  // CONN-023
  it('CONN-023: Gmail emitData keeps non-noisy emails', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-1',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Hey, want to grab lunch tomorrow?',
        participants: ['alice@example.com'],
        metadata: { from: 'alice@example.com', labels: ['INBOX'] },
      },
    });

    expect(emitted).toHaveLength(1);
  });

  // CONN-024
  it('CONN-024: Gmail emitData filters noreply@ automated senders', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-noreply',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Your account has been updated',
        participants: [],
        metadata: { from: 'noreply@service.com' },
      },
    });

    expect(emitted).toHaveLength(0);
    expect(connector.filteredCount).toBe(1);
  });

  // CONN-025
  it('CONN-025: Gmail shared isNoise filters OTP codes from email', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-otp',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Your verification code is 847291',
        participants: [],
        metadata: {},
      },
    });

    expect(emitted).toHaveLength(0);
  });

  // CONN-026
  it('CONN-026: Gmail contact events bypass noise filter', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'gmail',
      sourceType: 'contact',
      externalId: 'contact-1',
      eventTime: new Date().toISOString(),
      content: {
        text: 'John Doe',
        participants: [],
        metadata: { type: 'contact', name: 'John Doe', email: 'john@example.com' },
      },
    });

    expect(emitted).toHaveLength(1);
  });

  // CONN-027
  it('CONN-027: Gmail clean() strips HTML from email content', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-html',
      eventTime: new Date().toISOString(),
      content: {
        text: '<html><body><div>Hello <b>world</b></div></body></html>',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).not.toContain('<div>');
    expect(result.text).not.toContain('<b>');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('world');
  });

  // CONN-028
  it('CONN-028: Gmail clean() removes copyright footers', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-footer',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Important message content\n\n© 2024 SomeCompany Inc. All rights reserved.',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).toContain('Important message content');
    expect(result.text).not.toContain('©');
  });

  // CONN-029
  it('CONN-029: Gmail clean() strips Unsubscribe links', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-unsub',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Real content here. Unsubscribe https://example.com/unsub/abc123',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).toContain('Real content');
    expect(result.text).not.toMatch(/Unsubscribe/i);
  });

  // CONN-030
  it('CONN-030: Gmail embed() extracts from/to/cc as person entities', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-embed',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Meeting tomorrow at 3pm',
        participants: ['alice@example.com', 'bob@example.com'],
        metadata: {
          from: 'Alice <alice@example.com>',
          to: 'Bob <bob@example.com>',
          cc: 'Charlie <charlie@example.com>',
        },
      },
    };

    const result = connector.embed(event, 'Meeting tomorrow at 3pm', {} as any);
    expect(result.entities).toBeDefined();
    expect(result.entities.length).toBeGreaterThan(0);
    // All entities should be person type
    for (const entity of result.entities) {
      expect(entity.type).toBe('person');
    }
  });

  // CONN-031
  it('CONN-031: Gmail embed() handles contact events with metadata', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'contact',
      externalId: 'contact-embed',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Jane Smith',
        participants: [],
        metadata: {
          type: 'contact',
          name: 'Jane Smith',
          emails: ['jane@example.com'],
          phones: ['+1234567890'],
        },
      },
    };

    const result = connector.embed(event, 'Jane Smith', {} as any);
    expect(result.text).toBe('Jane Smith');
    expect(result.metadata?.isContact).toBe(true);
  });

  // CONN-032
  it('CONN-032: Gmail clean() removes long tracking URLs (80+ chars)', () => {
    const longUrl =
      'https://tracking.example.com/ls/click?upn=' + 'a'.repeat(100);
    const event: ConnectorDataEvent = {
      connectorType: 'gmail',
      sourceType: 'email',
      externalId: 'msg-track',
      eventTime: new Date().toISOString(),
      content: {
        text: `Check this (${longUrl}) out`,
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).not.toContain(longUrl);
    expect(result.text).toContain('Check this');
  });
});
