/**
 * CONN-102 → CONN-105: Other Connectors e2e tests.
 *
 * Tests Locations/OwnTracks, Outlook, and Telegram connectors.
 * External APIs are mocked — tests focus on connector manifest,
 * auth flow structure, and event emission logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';

// ---------------------------------------------------------------------------
// Locations / OwnTracks Connector (CONN-102 → CONN-103)
// ---------------------------------------------------------------------------

describe('Locations/OwnTracks Connector (CONN-102 → CONN-103)', () => {
  let connector: any;

  beforeEach(async () => {
    const mod = await import('@botmem/connector-locations');
    const Ctor = mod.LocationsConnector || mod.default;
    connector = typeof Ctor === 'function' && Ctor.prototype
      ? new Ctor()
      : (mod.default as Function)();
  });

  // CONN-102
  it('CONN-102: OwnTracks/Locations manifest has api-key authType', () => {
    expect(connector.manifest.id).toBe('locations');
    expect(connector.manifest.authType).toBe('api-key');
  });

  it('CONN-102a: Locations configSchema has host, user, device, username, password fields', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties).toHaveProperty('host');
    expect(schema.properties).toHaveProperty('user');
    expect(schema.properties).toHaveProperty('device');
    expect(schema.properties).toHaveProperty('username');
    expect(schema.properties).toHaveProperty('password');
  });

  it('CONN-102b: Locations manifest name contains OwnTracks', () => {
    expect(connector.manifest.name).toMatch(/OwnTracks|Locations/i);
  });

  // CONN-103
  it('CONN-103: OwnTracks location events emitted correctly', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'locations',
      sourceType: 'location',
      externalId: 'loc-1',
      eventTime: '2024-06-15T10:30:00Z',
      content: {
        text: 'Location at Dubai Mall',
        participants: [],
        metadata: {
          lat: 25.1972,
          lon: 55.2796,
          alt: 15,
          batt: 85,
          acc: 10,
        },
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].sourceType).toBe('location');
    expect(emitted[0].content?.metadata?.lat).toBe(25.1972);
  });

  it('CONN-103a: Locations manifest entities include location', () => {
    expect(connector.manifest.entities).toContain('location');
  });

  it('CONN-103b: Locations manifest has trustScore', () => {
    expect(connector.manifest.trustScore).toBeGreaterThan(0);
  });

  it('CONN-103c: Locations manifest has color and icon', () => {
    expect(connector.manifest.color).toBeTruthy();
    expect(connector.manifest.icon).toMatch(/map|pin|location/i);
  });

  it('CONN-103d: Locations clean() collapses whitespace', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'locations',
      sourceType: 'location',
      externalId: 'loc-clean',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Location   at   home',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).toBe('Location at home');
  });
});

// ---------------------------------------------------------------------------
// Outlook Connector (CONN-104)
// ---------------------------------------------------------------------------

describe('Outlook Connector (CONN-104)', () => {
  let connector: any;

  beforeEach(async () => {
    const mod = await import('@botmem/connector-outlook');
    const Ctor = mod.OutlookConnector || mod.default;
    connector = typeof Ctor === 'function' && Ctor.prototype
      ? new Ctor()
      : (mod.default as Function)();
  });

  // CONN-104
  it('CONN-104: Outlook manifest has oauth2 authType', () => {
    expect(connector.manifest.id).toBe('outlook');
    expect(connector.manifest.authType).toBe('oauth2');
  });

  it('CONN-104a: Outlook configSchema has clientId, clientSecret, tenantId', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties).toHaveProperty('clientId');
    expect(schema.properties).toHaveProperty('clientSecret');
    // tenantId might be optional
    if (schema.properties.tenantId) {
      expect(schema.properties.tenantId.type).toBe('string');
    }
  });

  it('CONN-104b: Outlook initiateAuth returns redirect URL to Microsoft', async () => {
    const result = await connector.initiateAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:12412/api/auth/outlook/callback',
    });

    expect(result.type).toBe('redirect');
    expect(result.url).toContain('microsoft');
  });

  it('CONN-104c: Outlook manifest entities include person and message', () => {
    expect(connector.manifest.entities).toContain('person');
    expect(connector.manifest.entities).toContain('message');
  });

  it('CONN-104d: Outlook manifest has trustScore', () => {
    expect(connector.manifest.trustScore).toBeGreaterThan(0);
    expect(connector.manifest.trustScore).toBeLessThanOrEqual(1);
  });

  it('CONN-104e: Outlook manifest pipeline has clean and embed', () => {
    expect(connector.manifest.pipeline.clean).not.toBe(false);
    expect(connector.manifest.pipeline.embed).not.toBe(false);
  });

  it('CONN-104f: Outlook emitData allows normal email events', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'outlook',
      sourceType: 'email',
      externalId: 'ol-msg-1',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Project update: milestone reached',
        participants: ['alice@microsoft.com'],
        metadata: { from: 'alice@microsoft.com' },
      },
    });

    expect(emitted).toHaveLength(1);
  });

  it('CONN-104g: Outlook emitData filters automated senders', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'outlook',
      sourceType: 'email',
      externalId: 'ol-noreply',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Your account has been updated',
        participants: [],
        metadata: { from: 'noreply@microsoft.com' },
      },
    });

    expect(emitted).toHaveLength(0);
  });

  it('CONN-104h: Outlook clean() strips HTML', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'outlook',
      sourceType: 'email',
      externalId: 'ol-html',
      eventTime: new Date().toISOString(),
      content: {
        text: '<html><body><p>Hello <strong>world</strong></p></body></html>',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).not.toContain('<p>');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('world');
  });

  it('CONN-104i: Outlook contact events bypass noise filter', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'outlook',
      sourceType: 'contact',
      externalId: 'ol-contact-1',
      eventTime: new Date().toISOString(),
      content: {
        text: 'John Doe',
        participants: [],
        metadata: { type: 'contact', name: 'John Doe' },
      },
    });

    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Telegram Connector (CONN-105)
// ---------------------------------------------------------------------------

describe('Telegram Connector (CONN-105)', () => {
  let connector: any;

  beforeEach(async () => {
    const mod = await import('@botmem/connector-telegram');
    const Ctor = mod.TelegramConnector || mod.default;
    connector = typeof Ctor === 'function' && Ctor.prototype
      ? new Ctor()
      : (mod.default as Function)();
  });

  // CONN-105
  it('CONN-105: Telegram manifest has phone-code authType', () => {
    expect(connector.manifest.id).toBe('telegram');
    expect(connector.manifest.authType).toBe('phone-code');
  });

  it('CONN-105a: Telegram configSchema requires phone number', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties).toHaveProperty('phone');
    expect(schema.required).toContain('phone');
  });

  it('CONN-105b: Telegram configSchema has optional apiId and apiHash', () => {
    const schema = connector.manifest.configSchema;
    expect(schema.properties).toHaveProperty('apiId');
    expect(schema.properties).toHaveProperty('apiHash');
    // These should NOT be in required
    if (schema.required) {
      expect(schema.required).not.toContain('apiId');
      expect(schema.required).not.toContain('apiHash');
    }
  });

  it('CONN-105c: Telegram initiateAuth requires phone number', async () => {
    await expect(connector.initiateAuth({})).rejects.toThrow(/phone/i);
  });

  it('CONN-105d: Telegram manifest entities include person and message', () => {
    expect(connector.manifest.entities).toContain('person');
    expect(connector.manifest.entities).toContain('message');
  });

  it('CONN-105e: Telegram manifest pipeline has clean and embed', () => {
    expect(connector.manifest.pipeline.clean).toBe(true);
    expect(connector.manifest.pipeline.embed).toBe(true);
    expect(connector.manifest.pipeline.enrich).toBe(false);
  });

  it('CONN-105f: Telegram manifest trustScore is 0.8', () => {
    expect(connector.manifest.trustScore).toBe(0.8);
  });

  it('CONN-105g: Telegram manifest color is blue (#26A5E4)', () => {
    expect(connector.manifest.color).toBe('#26A5E4');
  });

  it('CONN-105h: Telegram emitData allows normal messages', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'telegram',
      sourceType: 'message',
      externalId: 'tg-msg-1',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Hey, are you free for a call?',
        participants: ['+1234567890'],
        metadata: {},
      },
    });

    expect(emitted).toHaveLength(1);
  });

  it('CONN-105i: Telegram emitData filters OTP messages', () => {
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e: ConnectorDataEvent) => emitted.push(e));

    connector.emitData({
      connectorType: 'telegram',
      sourceType: 'message',
      externalId: 'tg-otp',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Your Telegram code is 54321',
        participants: [],
        metadata: {},
      },
    });

    expect(emitted).toHaveLength(0);
  });

  it('CONN-105j: Telegram clean() collapses whitespace', () => {
    const event: ConnectorDataEvent = {
      connectorType: 'telegram',
      sourceType: 'message',
      externalId: 'tg-clean',
      eventTime: new Date().toISOString(),
      content: {
        text: 'Hello    world',
        participants: [],
        metadata: {},
      },
    };

    const result = connector.clean(event, {} as any);
    expect(result.text).toBe('Hello world');
  });
});
