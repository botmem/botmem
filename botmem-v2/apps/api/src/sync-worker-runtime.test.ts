import { describe, expect, it } from 'vitest';
import {
  parseSyncWorkerRuntimeConfig,
  SyncWorkerRuntimeConfigError,
} from './sync-worker-runtime.js';

describe('hosted sync worker runtime configuration', () => {
  it('accepts only its worker database authority', () => {
    const config = parseSyncWorkerRuntimeConfig({
      NODE_ENV: 'production',
      WORKER_DATABASE_URL:
        'postgresql://botmem_worker:secret@db.example.invalid/botmem?sslmode=verify-full',
      WORKER_DATABASE_POOL_MAX: '7',
    });
    expect(config.databasePoolMax).toBe(7);
    expect(config.databaseUrl).toContain('botmem_worker');
  });

  it('rejects loopback and plaintext production databases', () => {
    expect(() =>
      parseSyncWorkerRuntimeConfig({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgresql://worker:secret@localhost/botmem?sslmode=require',
      }),
    ).toThrow(SyncWorkerRuntimeConfigError);
    expect(() =>
      parseSyncWorkerRuntimeConfig({
        NODE_ENV: 'production',
        WORKER_DATABASE_URL: 'postgresql://worker:secret@db.example.invalid/botmem',
      }),
    ).toThrow(SyncWorkerRuntimeConfigError);
  });

  it('collapses malformed secret-bearing URLs into field-only errors', () => {
    expect(() =>
      parseSyncWorkerRuntimeConfig({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: 'not a URL with super-secret-password',
      }),
    ).toThrow('WORKER_DATABASE_URL must be a valid URL');
    try {
      parseSyncWorkerRuntimeConfig({
        NODE_ENV: 'test',
        WORKER_DATABASE_URL: 'not a URL with super-secret-password',
      });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-password');
    }
  });
});
