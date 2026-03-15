import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from '../health.controller';

// Mock ioredis before importing anything that uses it
vi.mock('ioredis', () => {
  const mockPing = vi.fn();
  const mockDisconnect = vi.fn();
  const MockRedis = vi.fn().mockImplementation(() => ({
    ping: mockPing,
    disconnect: mockDisconnect,
    status: 'ready',
  }));
  return { default: MockRedis, __mockPing: mockPing, __mockDisconnect: mockDisconnect };
});

import 'ioredis';

// Access mock internals
const ioredisMock = (await import('ioredis')) as unknown as {
  __mockPing: ReturnType<typeof vi.fn>;
  __mockDisconnect: ReturnType<typeof vi.fn>;
};
const mockPing: ReturnType<typeof vi.fn> = ioredisMock.__mockPing;

describe('HealthController', () => {
  let controller: HealthController;
  let mockDbService: { healthCheck: ReturnType<typeof vi.fn> };
  let mockTypesenseService: { healthCheck: ReturnType<typeof vi.fn> };
  let mockConfigService: { redisUrl: string };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDbService = {
      healthCheck: vi.fn().mockResolvedValue(true),
    };

    mockTypesenseService = {
      healthCheck: vi.fn().mockResolvedValue(true),
    };

    mockConfigService = {
      redisUrl: 'redis://localhost:6379',
    };

    controller = new HealthController(mockDbService, mockTypesenseService, mockConfigService);
  });

  it('returns all services connected when everything is healthy', async () => {
    mockPing.mockResolvedValue('PONG');

    const result = await controller.getHealth();

    expect(result.status).toBe('ok');
    expect(result.services.postgres.connected).toBe(true);
    expect(result.services.redis.connected).toBe(true);
    expect(result.services.typesense.connected).toBe(true);
  });

  it('returns connected: false for a service that throws during probe', async () => {
    mockPing.mockRejectedValue(new Error('Connection refused'));

    const result = await controller.getHealth();

    expect(result.status).toBe('ok');
    expect(result.services.postgres.connected).toBe(true);
    expect(result.services.redis.connected).toBe(false);
    expect(result.services.typesense.connected).toBe(true);
  });

  it('returns 200 with all services down (never throws)', async () => {
    mockDbService.healthCheck.mockRejectedValue(new Error('DB connection failed'));
    mockTypesenseService.healthCheck.mockResolvedValue(false);
    mockPing.mockRejectedValue(new Error('Connection refused'));

    const result = await controller.getHealth();

    expect(result.status).toBe('ok');
    expect(result.services.postgres.connected).toBe(false);
    expect(result.services.redis.connected).toBe(false);
    expect(result.services.typesense.connected).toBe(false);
  });

  it('TypesenseService.healthCheck returning false yields connected: false', async () => {
    mockPing.mockResolvedValue('PONG');
    mockTypesenseService.healthCheck.mockResolvedValue(false);

    const result = await controller.getHealth();

    expect(result.services.typesense.connected).toBe(false);
  });
});
