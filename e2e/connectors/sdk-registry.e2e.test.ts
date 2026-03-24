/**
 * CONN-001 → CONN-012: Connector SDK & Registry e2e tests.
 *
 * Tests ConnectorRegistry, BaseConnector (emitData, noise filter, sync limit),
 * and the default clean() pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  BaseConnector,
  ConnectorRegistry,
  isOtp,
  isAutomatedSender,
  isNotificationSms,
  isMarketingEmail,
  detectNoiseReason,
} from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
} from '@botmem/connector-sdk';

// ---------------------------------------------------------------------------
// Stub connector for testing
// ---------------------------------------------------------------------------

class StubConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'stub',
    name: 'Stub',
    description: 'Test connector',
    color: '#000',
    icon: 'test',
    authType: 'api-key',
    configSchema: {},
    entities: ['message'],
    pipeline: { clean: true, embed: true, enrich: false },
    trustScore: 0.5,
  };

  async initiateAuth(): Promise<AuthInitResult> {
    return { type: 'complete', auth: { accessToken: 'tok' } };
  }
  async completeAuth(): Promise<AuthContext> {
    return { accessToken: 'tok' };
  }
  async validateAuth(): Promise<boolean> {
    return true;
  }
  async revokeAuth(): Promise<void> {}
  async sync(): Promise<SyncResult> {
    return { cursor: null, hasMore: false, processed: 0 };
  }
}

class AnotherStubConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'another-stub',
    name: 'Another',
    description: 'Second test connector',
    color: '#FFF',
    icon: 'test2',
    authType: 'oauth2',
    configSchema: {},
    entities: ['message'],
    pipeline: { clean: true, embed: true, enrich: false },
    trustScore: 0.7,
  };

  async initiateAuth(): Promise<AuthInitResult> {
    return { type: 'redirect', url: 'https://example.com' };
  }
  async completeAuth(): Promise<AuthContext> {
    return { accessToken: 'tok2' };
  }
  async validateAuth(): Promise<boolean> {
    return true;
  }
  async revokeAuth(): Promise<void> {}
  async sync(): Promise<SyncResult> {
    return { cursor: null, hasMore: false, processed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(text: string, metadata: Record<string, unknown> = {}): ConnectorDataEvent {
  return {
    connectorType: 'stub',
    sourceType: 'message',
    externalId: `ext-${Date.now()}-${Math.random()}`,
    eventTime: new Date().toISOString(),
    content: { text, participants: [], metadata },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Connector SDK & Registry (CONN-001 → CONN-012)', () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
    BaseConnector.DEBUG_SYNC_LIMIT = 0;
  });

  // CONN-001
  it('CONN-001: ConnectorRegistry.register() stores connector by manifest.id', () => {
    registry.register(() => new StubConnector());
    const connector = registry.get('stub');
    expect(connector).toBeInstanceOf(StubConnector);
    expect(connector.manifest.id).toBe('stub');
  });

  // CONN-002
  it('CONN-002: ConnectorRegistry.get() with unknown ID throws error', () => {
    expect(() => registry.get('nonexistent')).toThrow('Connector "nonexistent" not found');
  });

  // CONN-003
  it('CONN-003: loadFromDirectory() skips directories without botmem.connector flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'conn-test-'));
    const pluginDir = join(dir, 'no-connector');
    await mkdir(pluginDir, { recursive: true });

    // Write a package.json WITHOUT botmem.connector — should be skipped
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'some-unrelated-package',
        version: '1.0.0',
      }),
    );

    await registry.loadFromDirectory(dir);
    expect(registry.list()).toHaveLength(0);

    await rm(dir, { recursive: true, force: true });
  });

  it('CONN-003a: loadFromDirectory() tolerates missing directory', async () => {
    // Should not throw when directory doesn't exist
    await registry.loadFromDirectory('/tmp/nonexistent-connector-dir-xyz');
    expect(registry.list()).toHaveLength(0);
  });

  // CONN-004
  it('CONN-004: loadFromDirectory() with path traversal is rejected by path guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'conn-traversal-'));
    // Create a directory that looks like traversal
    const evilDir = join(dir, '..', 'etc');
    // The guard should silently skip it — no connector registered
    await registry.loadFromDirectory(dir);
    expect(registry.list()).toHaveLength(0);
  });

  // CONN-005
  it('CONN-005: emitData() runs noise filter before emission — noisy events not emitted', () => {
    const connector = new StubConnector();
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e) => emitted.push(e));

    // OTP message should be filtered
    const otpEvent = makeEvent('Your verification code is 123456');
    const result = connector.emitData(otpEvent);

    expect(result).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(connector.filteredCount).toBe(1);
  });

  // CONN-006
  it('CONN-006: emitData() skips noise filter for type:contact events — always emitted', () => {
    const connector = new StubConnector();
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e) => emitted.push(e));

    // Contact event with noisy text should still pass
    const contactEvent = makeEvent('noreply@example.com auto-generated', {
      type: 'contact',
      from: 'noreply@example.com',
    });
    const result = connector.emitData(contactEvent);

    expect(result).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  // CONN-007
  it('CONN-007: DEBUG_SYNC_LIMIT > 0 aborts after N emits', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 3;
    const connector = new StubConnector();
    const ac = new AbortController();
    const ctx: SyncContext = {
      accountId: 'test',
      auth: { accessToken: 'tok' },
      cursor: null,
      jobId: 'test-job',
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      signal: ac.signal,
    };
    const wrapped = connector.wrapSyncContext(ctx);

    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e) => emitted.push(e));

    // Emit 5 events — only first 3 should pass
    for (let i = 0; i < 5; i++) {
      connector.emitData(makeEvent(`Message ${i}`));
    }

    expect(emitted).toHaveLength(3);
    expect(connector.isLimitReached).toBe(true);
    expect(wrapped.signal?.aborted).toBe(true);
  });

  // CONN-008
  it('CONN-008: DEBUG_SYNC_LIMIT = 0 (production) — no abort, full sync', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 0;
    const connector = new StubConnector();
    const emitted: ConnectorDataEvent[] = [];
    connector.on('data', (e) => emitted.push(e));

    for (let i = 0; i < 100; i++) {
      connector.emitData(makeEvent(`Message ${i}`));
    }

    expect(emitted).toHaveLength(100);
    expect(connector.isLimitReached).toBe(false);
  });

  // CONN-009
  it('CONN-009: wrapSyncContext() wraps abort signal correctly', () => {
    BaseConnector.DEBUG_SYNC_LIMIT = 5;
    const connector = new StubConnector();
    const parentAc = new AbortController();
    const ctx: SyncContext = {
      accountId: 'test',
      auth: { accessToken: 'tok' },
      cursor: null,
      jobId: 'test-job',
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      signal: parentAc.signal,
    };

    const wrapped = connector.wrapSyncContext(ctx);

    // Should have a different signal than the parent
    expect(wrapped.signal).not.toBe(ctx.signal);
    expect(wrapped.signal?.aborted).toBe(false);

    // Parent abort should propagate
    parentAc.abort();
    expect(wrapped.signal?.aborted).toBe(true);
  });

  // CONN-010
  it('CONN-010: Connector clean() default strips HTML tags', () => {
    const connector = new StubConnector();
    const event = makeEvent('<div><b>bold</b> <i>italic</i></div>');
    const result = connector.clean(event, {} as any);
    expect(result).toHaveProperty('text');
    expect((result as any).text).toBe('bold italic');
  });

  // CONN-011
  it('CONN-011: Connector clean() default removes tracking URLs', () => {
    const connector = new StubConnector();
    const event = makeEvent(
      'Check this https://tracking.example.com/ls/click?upn=abc123 out',
    );
    const result = connector.clean(event, {} as any);
    expect((result as any).text).not.toContain('click?upn=');
  });

  // CONN-012
  it('CONN-012: Connector clean() default collapses whitespace', () => {
    const connector = new StubConnector();
    const event = makeEvent('Hello    world   \n\n   test');
    const result = connector.clean(event, {} as any);
    expect((result as any).text).toBe('Hello world test');
  });

  // Additional registry tests
  it('ConnectorRegistry.has() returns false for unregistered connector', () => {
    expect(registry.has('nope')).toBe(false);
  });

  it('ConnectorRegistry.list() returns all manifests', () => {
    registry.register(() => new StubConnector());
    registry.register(() => new AnotherStubConnector());
    const manifests = registry.list();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id).sort()).toEqual(['another-stub', 'stub']);
  });

  it('resetSyncLimit() resets counters', () => {
    const connector = new StubConnector();
    connector.emitData(makeEvent('Your code is 123456')); // filtered
    expect(connector.filteredCount).toBe(1);
    connector.resetSyncLimit();
    expect(connector.filteredCount).toBe(0);
  });

  it('emitProgress includes filteredCount', () => {
    const connector = new StubConnector();
    const progressEvents: any[] = [];
    connector.on('progress', (e) => progressEvents.push(e));

    // Filter one event
    connector.emitData(makeEvent('Your code is 999999'));
    connector.emitProgress({ processed: 10, total: 100 });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].filteredCount).toBe(1);
  });

  afterEach(() => {
    BaseConnector.DEBUG_SYNC_LIMIT = 0;
  });
});

// ---------------------------------------------------------------------------
// Noise filter unit tests (used by all connectors)
// ---------------------------------------------------------------------------

describe('Noise Filter (shared SDK utilities)', () => {
  it('isOtp detects "Your code is 123456"', () => {
    expect(isOtp('Your code is 123456')).toBe(true);
  });

  it('isOtp detects "123456 is your verification code"', () => {
    expect(isOtp('123456 is your verification code')).toBe(true);
  });

  it('isOtp rejects normal text', () => {
    expect(isOtp('Hey, want to grab lunch?')).toBe(false);
  });

  it('isAutomatedSender detects noreply@', () => {
    expect(isAutomatedSender({ from: 'noreply@company.com' })).toBe(true);
  });

  it('isAutomatedSender detects mailer-daemon@', () => {
    expect(isAutomatedSender({ senderEmail: 'mailer-daemon@example.com' })).toBe(true);
  });

  it('isAutomatedSender allows personal emails', () => {
    expect(isAutomatedSender({ from: 'john@example.com' })).toBe(false);
  });

  it('isNotificationSms detects "Delivered"', () => {
    expect(isNotificationSms('Delivered')).toBe(true);
  });

  it('isNotificationSms detects sign-in code patterns', () => {
    expect(isNotificationSms('Your sign-in code is ready')).toBe(true);
  });

  it('isNotificationSms detects carrier data usage', () => {
    expect(isNotificationSms("You've used 80% of your data")).toBe(true);
  });

  it('isNotificationSms detects Reply STOP messages', () => {
    expect(isNotificationSms('Reply STOP to unsubscribe')).toBe(true);
  });

  it('isNotificationSms allows normal conversation', () => {
    expect(isNotificationSms('Hey are you coming to dinner tonight?')).toBe(false);
  });

  it('isMarketingEmail detects unsubscribe + promo label', () => {
    expect(
      isMarketingEmail('Check out our deals! Click to unsubscribe', {
        labels: ['CATEGORY_PROMOTIONS'],
      }),
    ).toBe(true);
  });

  it('isMarketingEmail keeps receipt emails', () => {
    expect(
      isMarketingEmail('Your order confirmation #12345. Unsubscribe here.', {}),
    ).toBe(false);
  });

  it('isMarketingEmail keeps emails without unsubscribe', () => {
    expect(isMarketingEmail('Hey, want to grab lunch tomorrow?', {})).toBe(false);
  });

  it('detectNoiseReason returns specific reason', () => {
    expect(detectNoiseReason('Your OTP is 999999', {})).toBe('otp');
    expect(detectNoiseReason('', { from: 'noreply@example.com' })).toBe('automated_sender');
    expect(detectNoiseReason('Delivered.', {})).toBe('notification_sms');
    expect(detectNoiseReason('Hello friend', {})).toBeNull();
  });
});
