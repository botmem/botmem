import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsService } from '../analytics.service';
import type { ConfigService } from '../../config/config.service';

// Mock posthog-node
const mockCapture = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: mockCapture,
    shutdown: mockShutdown,
  })),
}));

function makeConfigService(apiKey: string) {
  return { posthogApiKey: apiKey } as unknown as ConfigService;
}

describe('AnalyticsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when posthogApiKey is empty string', () => {
    const service = new AnalyticsService(makeConfigService(''));
    service.capture('test_event', { foo: 'bar' });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('creates PostHog client and calls capture when apiKey is set', () => {
    const service = new AnalyticsService(makeConfigService('phc_test123'));
    service.capture('test_event', { foo: 'bar' });
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'server',
      event: 'test_event',
      properties: { foo: 'bar' },
    });
  });

  it('passes distinctId=server with event name and properties', () => {
    const service = new AnalyticsService(makeConfigService('phc_key'));
    service.capture('sync_complete', { connector_type: 'gmail', duration_ms: 1234 });
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'server',
      event: 'sync_complete',
      properties: { connector_type: 'gmail', duration_ms: 1234 },
    });
  });

  it('calls client.shutdown() on module destroy when client exists', async () => {
    const service = new AnalyticsService(makeConfigService('phc_key'));
    await service.onModuleDestroy();
    expect(mockShutdown).toHaveBeenCalled();
  });

  it('does not throw on module destroy when client is null (no API key)', async () => {
    const service = new AnalyticsService(makeConfigService(''));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(mockShutdown).not.toHaveBeenCalled();
  });
});
