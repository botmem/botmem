import { describe, expect, it } from 'vitest';
import { DeviceRuntimeConfigError, parseDeviceRuntimeConfig } from './composition.js';

describe('device runtime configuration', () => {
  it('normalizes bounded production transport values', () => {
    expect(
      parseDeviceRuntimeConfig({
        REDIS_URL: 'rediss://redis.example.invalid:6379',
        API_REPLICA_ID: 'api-1',
        DEVICE_CREDENTIAL_TTL_SECONDS: '300',
        DEVICE_HEARTBEAT_INTERVAL_MS: '10000',
      }),
    ).toMatchObject({
      redisUrl: 'rediss://redis.example.invalid:6379',
      replicaId: 'api-1',
      credentialLifetimeMs: 300_000,
      heartbeatIntervalMs: 10_000,
    });
  });

  it('fails closed for a non-Redis transport or missing replica identity', () => {
    expect(() =>
      parseDeviceRuntimeConfig({
        REDIS_URL: 'https://redis.example.invalid',
        API_REPLICA_ID: 'api-1',
      }),
    ).toThrow(DeviceRuntimeConfigError);
    expect(() =>
      parseDeviceRuntimeConfig({ REDIS_URL: 'rediss://redis.example.invalid' }),
    ).toThrow();
  });

  it('rejects plaintext Redis in production but permits loopback test infrastructure', () => {
    expect(() =>
      parseDeviceRuntimeConfig({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://redis.example.invalid:6379',
        API_REPLICA_ID: 'api-1',
      }),
    ).toThrow('TLS');
    expect(
      parseDeviceRuntimeConfig({
        NODE_ENV: 'test',
        REDIS_URL: 'redis://127.0.0.1:6379',
        API_REPLICA_ID: 'api-test',
      }).redisUrl,
    ).toBe('redis://127.0.0.1:6379');
  });
});
